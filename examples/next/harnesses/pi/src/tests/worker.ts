import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall
} from "@earendil-works/pi-ai";
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { Streams } from "agents/streams";
import { Type } from "typebox";
import { PI_OPERATION_DEFINITION, PiHarness } from "../harness/pi-harness";
import { PI_DRIVE_EFFECT } from "../harness/machine";
import type { PiEvent, PiMessage, PiTool } from "../harness/types";
import { createModels } from "../providers/models";

const multiplyParameters = Type.Object({ value: Type.Number() });
const noParameters = Type.Object({});
const TOOL_REVISION_KEY = "test:pi:revision";
/**
 * Durable gate for the slow tool.
 *
 * It lives in storage rather than in a field so it survives eviction: a test
 * can hold an operation open, drop the isolate, and have the operation still
 * be genuinely in flight when the object wakes.
 */
const TOOL_GATE_KEY = "test:pi:gate";
const GATE_POLL_MS = 10;
/** Bounds the gated tool so a stuck gate cannot pin the object forever. */
const GATE_MAX_POLLS = 300;

type ToolContext = {
  readonly revision: number;
};

/** A test-shaped projection of the outer machine's control state. */
export type MachineView = {
  status: string;
  phase?: string;
  result?: unknown;
  error?: string;
  /** The durable effect rows, so tests can assert the recovery policy. */
  effects?: {
    kind: string;
    recovery: string;
    status: string;
    externalId?: string;
  }[];
};

function messageText(message: PiMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

/**
 * A faux response derived from the transcript rather than a queue.
 *
 * A queued script lives in the isolate and disappears with it, so an evicted
 * run would fail for a reason that has nothing to do with durability. This
 * factory answers from the durable transcript instead: it asks for the tool
 * when no result is present yet, and finishes once one is, which is exactly
 * what a real provider does when pi replays its context.
 */
function transcriptDrivenResponse(context: {
  readonly messages: readonly { role: string; content: unknown }[];
}): ReturnType<typeof fauxAssistantMessage> {
  const hasToolResult = context.messages.some(
    (message) => message.role === "toolResult"
  );
  if (hasToolResult) return fauxAssistantMessage("tool complete");
  const prompt = context.messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content)
    )
    .join(" ");
  const value = Number(/multiply (-?\d+(?:\.\d+)?)/.exec(prompt)?.[1] ?? 0);
  return fauxAssistantMessage(fauxToolCall("multiply", { value }), {
    stopReason: "toolUse"
  });
}

/** Real Durable Object fixture using pi-ai's faux provider. */
export class PiHarnessTestObject extends DurableObject<Env> {
  readonly #faux = fauxProvider();
  readonly streams = new Streams();
  readonly harness = new PiHarness<ToolContext>({
    models: createModels({ providers: [this.#faux.provider] }),
    model: this.#faux.getModel(),
    streams: this.streams,
    thinkingLevel: "off",
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
    compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
    toolContext: async () => ({
      revision: (await this.ctx.storage.get<number>(TOOL_REVISION_KEY)) ?? 1
    }),
    tools: () => [this.#multiplyTool(), this.#slowTool()],
    systemPrompt: "Use the supplied test tool."
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.streams)
    .use(this.harness.stateMachine)
    .use(this.harness);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // A scripted queue is process-local and would vanish with the isolate.
    // Re-seeding on every wake makes the fixture behave like a real provider,
    // so an eviction test measures the harness's durability, not the script's.
    this.#useTranscriptResponses();
  }

  /** Run one pi-ai faux-provider turn containing a tool call. */
  async runMultiply(
    value: number,
    revision: number
  ): Promise<{
    readonly operationId: string;
    readonly status: string;
    readonly messages: readonly string[];
    readonly result: number | null;
  }> {
    await this.ctx.storage.put(TOOL_REVISION_KEY, revision);
    this.#faux.setResponses([
      fauxAssistantMessage(fauxToolCall("multiply", { value }), {
        stopReason: "toolUse"
      }),
      fauxAssistantMessage("tool complete")
    ]);
    const response = await this.harness.prompt(`multiply ${value}`);
    const resultPart = response.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool-result")
      .at(-1);
    const result =
      resultPart?.type === "tool-result" &&
      typeof resultPart.details === "object" &&
      resultPart.details !== null &&
      "result" in resultPart.details &&
      typeof resultPart.details.result === "number"
        ? resultPart.details.result
        : null;
    return {
      operationId: response.operationId,
      status: response.status,
      messages: response.messages.map(messageText),
      result
    };
  }

  /** Read the durable transcript without starting another model turn. */
  async messages(): Promise<readonly string[]> {
    return (await this.harness.getMessages()).map(messageText);
  }

  /** The outer machine's phase and status for one operation. */
  async machine(operationId: string): Promise<MachineView | null> {
    const snapshot = await this.harness.inspect(operationId);
    if (!snapshot) return null;
    const view: MachineView = { status: snapshot.status };
    if (
      snapshot.status === "running" ||
      snapshot.status === "waiting" ||
      snapshot.status === "paused"
    ) {
      view.phase = snapshot.state.phase;
    }
    if (snapshot.status === "completed") view.result = snapshot.result;
    if (snapshot.status === "failed" || snapshot.status === "cancelled") {
      view.error = snapshot.error.message;
    }
    if (
      snapshot.status === "running" ||
      snapshot.status === "waiting" ||
      snapshot.status === "paused"
    ) {
      view.effects = (snapshot.effects ?? []).map((effect) => ({
        kind: effect.kind,
        recovery: effect.recovery,
        status: effect.status,
        externalId: effect.externalId
      }));
    }
    return view;
  }

  /**
   * Submit without waiting, so a test can evict the object while the
   * operation is still live and prove the machine reconciles it.
   */
  async submitOnly(
    value: number,
    revision: number
  ): Promise<{ operationId: string; accepted: boolean }> {
    await this.ctx.storage.put(TOOL_REVISION_KEY, revision);
    this.#useTranscriptResponses();
    const receipt = await this.harness.submit({
      kind: "prompt",
      prompt: `multiply ${value}`
    });
    return { operationId: receipt.operationId, accepted: receipt.accepted };
  }

  /**
   * Script the provider from the durable transcript so responses survive an
   * eviction, the way a real provider's would.
   *
   * The faux provider consumes one scripted step per request, so the same
   * stateless factory is seeded several times; which reply it returns is
   * decided by the transcript, not by queue position.
   */
  #useTranscriptResponses(): void {
    this.#faux.setResponses(
      Array.from(
        { length: 8 },
        () => (context: unknown) =>
          transcriptDrivenResponse(
            context as {
              messages: readonly { role: string; content: unknown }[];
            }
          )
      )
    );
  }

  /** Wait for one already-submitted operation to settle. */
  async awaitResult(
    operationId: string
  ): Promise<{ status: string; error?: string }> {
    const result = await this.harness.waitForResult(operationId);
    return {
      status: result.status,
      ...(result.error === undefined
        ? {}
        : { error: `${result.error.code}: ${result.error.message}` })
    };
  }

  /** Read projected event type names from one operation's durable stream. */
  async eventTypes(operationId: string): Promise<readonly string[]> {
    const events: PiEvent[] = [];
    for await (const chunk of this.streams.read(
      this.harness.streamId(operationId)
    )) {
      events.push(...(chunk.chunk as unknown as PiEvent[]));
    }
    return events.map((event) => event.type);
  }

  // ── Gated operations ─────────────────────────────────────────────────────

  /**
   * Submit a prompt whose tool call blocks until {@link releaseGate}.
   *
   * The gate is durable, so the operation is still genuinely in flight after
   * an eviction. That is what lets a test exercise reconciliation, parking,
   * and cancellation instead of racing a fast happy path.
   */
  async submitGated(
    value: number
  ): Promise<{ operationId: string; accepted: boolean }> {
    await this.ctx.storage.put(TOOL_GATE_KEY, "held");
    this.#useGatedResponses();
    const receipt = await this.harness.submit({
      kind: "prompt",
      prompt: `slow ${value}`
    });
    return { operationId: receipt.operationId, accepted: receipt.accepted };
  }

  /** Let a gated tool call finish. */
  async releaseGate(): Promise<void> {
    await this.ctx.storage.put(TOOL_GATE_KEY, "released");
  }

  /** Whether the gated tool is currently executing. */
  async gateState(): Promise<string | undefined> {
    return this.ctx.storage.get<string>(TOOL_GATE_KEY);
  }

  /** Durably abort one operation, as a client would. */
  async abort(operationId: string): Promise<boolean> {
    const result = await this.harness.abort({ operationId });
    return result !== null;
  }

  /** Pi's own terminal record, independent of the machine checkpoint. */
  async piResult(operationId: string): Promise<string | null> {
    const result = await this.harness.getResult(operationId);
    return result?.status ?? null;
  }

  /** Submissions the harness has queued but pi has not yet admitted. */
  async pendingCount(): Promise<number> {
    return (await this.harness.pending()).length;
  }

  /**
   * Seed a machine run whose drive pass is durably `running` with no result.
   *
   * This is the uncertain-effect crash position: the intent is committed and
   * the external execution may or may not have happened, but the isolate
   * died before settlement. Timing a real process kill to land here is not
   * reproducible, so the state is written directly — the approach the SDK's
   * own effect-recovery tests use. Resuming forces recovery down the
   * `reconcile` path, which is the whole point of wrapping pi rather than
   * replaying it.
   *
   * `pi` decides the outcome: a recorded terminal result reconciles to
   * completed, a live operation to running, and an unknown id to not-found.
   */
  async seedUncertainDrivePass(options: {
    readonly operationId: string;
    readonly pass?: number;
  }): Promise<string> {
    // Make sure the capability's tables exist before writing to them.
    await this.harness.inspect("schema-touch");
    const { operationId } = options;
    const pass = options.pass ?? 0;
    const runId = this.harness.runIdFor(operationId);
    const effectId = `effect_seeded_${pass}`;
    const streamId = this.harness.streamId(operationId);
    const now = Date.now();
    const checkpoint = JSON.stringify({
      phase: "drive",
      lane: "main",
      operationId,
      streamId,
      effect: {
        id: effectId,
        kind: PI_DRIVE_EFFECT,
        recovery: "reconcile"
      },
      pass
    });
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO cf_agents_state_machine_runs
          (run_id, definition, definition_version, status, phase,
           checkpoint_json, revision, control_json, job_id, wait_kind,
           wait_type, wait_key, next_at, event_sequence, cancel_requested,
           cancel_reason, result_json, error_name, error_message, persist,
           idempotency_key, created_at, updated_at, settled_at)
         VALUES (?, ?, 1, 'paused', 'drive', ?, 1, '{"status":"running"}',
                 ?, NULL, NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL,
                 1, NULL, ?, ?, NULL)`,
        runId,
        PI_OPERATION_DEFINITION,
        checkpoint,
        `state-machine:${runId}`,
        now,
        now
      );
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO cf_agents_state_machine_effects
          (run_id, effect_id, revision, kind, recovery, status, input_json,
           external_id, result_json, error_name, error_message, created_at,
           settled_at)
         VALUES (?, ?, 1, ?, 'reconcile', 'running', ?, ?, NULL, NULL, NULL,
                 ?, NULL)`,
        runId,
        effectId,
        PI_DRIVE_EFFECT,
        JSON.stringify({
          lane: "main",
          operationId,
          request: null,
          streamId,
          pass
        }),
        // The external id the runtime reconciles against.
        `${operationId}:${pass}`,
        now
      );
    });
    return runId;
  }

  /** Resume a seeded run so recovery runs. */
  async resumeRun(operationId: string): Promise<boolean> {
    return this.harness.resume(operationId);
  }

  /**
   * Seed a run parked in the `waiting` phase, as pi's retry backoff and
   * deferred polling produce.
   *
   * Resuming must plan a fresh pass and re-enter `drive`, which is how one
   * operation spans several bounded passes without holding an invocation.
   * The pass number is carried forward so the new effect gets its own id
   * rather than colliding with the completed one.
   */
  async seedWaitingRun(options: {
    readonly operationId: string;
    readonly pass?: number;
  }): Promise<string> {
    await this.harness.inspect("schema-touch");
    const { operationId } = options;
    const pass = options.pass ?? 0;
    const runId = this.harness.runIdFor(operationId);
    const now = Date.now();
    const checkpoint = JSON.stringify({
      phase: "waiting",
      lane: "main",
      operationId,
      streamId: this.harness.streamId(operationId),
      pass,
      notBefore: now
    });
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO cf_agents_state_machine_runs
        (run_id, definition, definition_version, status, phase,
         checkpoint_json, revision, control_json, job_id, wait_kind,
         wait_type, wait_key, next_at, event_sequence, cancel_requested,
         cancel_reason, result_json, error_name, error_message, persist,
         idempotency_key, created_at, updated_at, settled_at)
       VALUES (?, ?, 1, 'paused', 'waiting', ?, 1, '{"status":"running"}',
               ?, NULL, NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL,
               1, NULL, ?, ?, NULL)`,
      runId,
      PI_OPERATION_DEFINITION,
      checkpoint,
      `state-machine:${runId}`,
      now,
      now
    );
    return runId;
  }

  #useGatedResponses(): void {
    this.#faux.setResponses(
      Array.from({ length: 8 }, () => (context: unknown) => {
        const { messages } = context as {
          messages: readonly { role: string; content: unknown }[];
        };
        if (messages.some((message) => message.role === "toolResult")) {
          return fauxAssistantMessage("slow complete");
        }
        return fauxAssistantMessage(fauxToolCall("slow", {}), {
          stopReason: "toolUse"
        });
      })
    );
  }

  /** A tool that parks until its durable gate opens. */
  #slowTool(): PiTool<ToolContext, typeof noParameters, { released: boolean }> {
    const storage = this.ctx.storage;
    return {
      name: "slow",
      label: "Slow",
      description: "Block until the test releases it.",
      parameters: noParameters,
      // The call must not be repeated on recovery; the harness has to ask pi
      // what happened rather than run it again.
      replay: "never",
      async execute(_id, _input, _onUpdate, _context, _invocation, piContext) {
        // Poll a bounded number of times rather than forever. An unbounded
        // in-flight promise keeps the Durable Object pinned, and
        // `evictDurableObject()` would never return; the deadline lets the
        // test evict while pi still considers the operation live.
        for (let attempt = 0; attempt < GATE_MAX_POLLS; attempt++) {
          if ((await storage.get<string>(TOOL_GATE_KEY)) === "released") {
            return {
              content: [{ type: "text", text: "released" }],
              details: { released: true }
            };
          }
          if (piContext.abortSignal?.aborted) {
            throw new Error("slow tool aborted");
          }
          await scheduler.wait(GATE_POLL_MS);
        }
        throw new Error("slow tool gate never opened");
      }
    };
  }

  #multiplyTool(): PiTool<
    ToolContext,
    typeof multiplyParameters,
    { readonly result: number; readonly revision: number }
  > {
    return {
      name: "multiply",
      label: "Multiply",
      description: "Multiply by the current tool revision.",
      parameters: multiplyParameters,
      replay: "safe",
      async execute(_id, input, _onUpdate, context) {
        const result = input.value * context.revision;
        return {
          content: [{ type: "text", text: String(result) }],
          details: { result, revision: context.revision }
        };
      }
    };
  }
}

export default { fetch: () => new Response("Not found", { status: 404 }) };
