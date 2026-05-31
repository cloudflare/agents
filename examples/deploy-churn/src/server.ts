/**
 * Deploy-churn recovery harness — Worker entry + agent.
 *
 * The wrangler-dev kill/restart e2e tests cover one class of eviction (process
 * dies, same code restarts against the same persisted state). A *real* deploy
 * is different: `wrangler deploy` ships a NEW script version, and an in-flight
 * Durable Object running the OLD version is reset with
 * "Durable Object reset because its code was updated". Storage calls on that
 * stale isolate keep throwing for the rest of the invocation; fresh code only
 * loads on the next execution (a new requestId).
 *
 * This is a `Think` agent (matching the runtime the customer report describes:
 * `continueLastTurn`, durable submissions, the `_chatRecoveryContinue` alarm).
 * It is intentionally LLM-free and deterministic: `getModel()` returns a mock
 * model that streams one chunk per second for a configurable duration, so a
 * deploy reliably lands mid-turn. `chatRecovery` is enabled, so an interrupted
 * turn is wrapped in a durable fiber and continued via the alarm-scheduled
 * `_chatRecoveryContinue`.
 *
 * Error visibility is the point of this file. We capture BOTH error hooks:
 *   - `onChatError(error, ctx)` — per-turn failures, tagged with a `stage`
 *     ("turn" | "stream" | "recovery" | ...). `stage: "recovery"` is exactly
 *     the case the report cares about: a recovery continuation that failed on a
 *     stale, just-superseded isolate.
 *   - `onError(error)` — agent-level failures (scheduled callback dispatch,
 *     scheduled task execution) that never reach a chat turn.
 * Both are logged as one structured JSON line (`"kind":"deploy-churn"`) so they
 * are queryable via `wrangler tail` / the Workers Observability MCP server, and
 * persisted to storage so the orchestrator can read them over RPC.
 */
import { Think } from "@cloudflare/think";
import type {
  ChatErrorContext,
  ChatRecoveryConfig,
  ChatRecoveryContext,
  ChatRecoveryExhaustedContext,
  ChatRecoveryOptions,
  ChatResponseResult,
  ChunkContext,
  ThinkSubmissionInspection
} from "@cloudflare/think";
import { callable, getAgentByName, routeAgentRequest } from "agents";
import { generateText, jsonSchema, tool } from "ai";
import type { LanguageModel, ModelMessage, ToolSet, UIMessage } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { createAnthropic } from "@ai-sdk/anthropic";

type Provider = "workers-ai" | "anthropic";

type Env = {
  DeployChurnAgent: DurableObjectNamespace<DeployChurnAgent>;
  AI: Ai;
  ANTHROPIC_API_KEY?: string;
};

const DEFAULT_WORKERS_AI_MODEL = "@cf/moonshotai/kimi-k2.6";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";

/**
 * Probe whether a model rejects a transcript ending in an assistant message —
 * exactly what `continueLastTurn` replays when it continues a partial assistant
 * turn after a deploy interruption. `trailing-user` is the control.
 *
 * Workers AI / Kimi tolerate the trailing assistant (they just respond);
 * Anthropic 4.6+ returns a 400 ("prefill not supported"), which is what the
 * customer hits in production.
 */
async function probeTrailingRole(
  env: Env,
  trailingRole: "assistant" | "user",
  provider: "workers-ai" | "anthropic",
  modelId: string
): Promise<Record<string, unknown>> {
  let model: LanguageModel;
  if (provider === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) {
      return {
        provider,
        ok: false,
        error: "ANTHROPIC_API_KEY not set (add it to .dev.vars)"
      };
    }
    model = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })(modelId);
  } else {
    model = createWorkersAI({ binding: env.AI })(modelId);
  }

  const messages: ModelMessage[] =
    trailingRole === "assistant"
      ? [
          { role: "user", content: "Give me a one-sentence greeting." },
          // The partial assistant message a recovery continuation replays.
          { role: "assistant", content: "Sure, here is a greeting:" }
        ]
      : [{ role: "user", content: "Give me a one-sentence greeting." }];
  const startedAt = Date.now();
  try {
    // maxRetries: 0 so a 400 surfaces immediately instead of being retried.
    const { text } = await generateText({ model, messages, maxRetries: 0 });
    return {
      provider,
      model: modelId,
      trailingRole,
      ok: true,
      durationMs: Date.now() - startedAt,
      textPreview: text.slice(0, 200)
    };
  } catch (error) {
    return {
      provider,
      model: modelId,
      trailingRole,
      ok: false,
      durationMs: Date.now() - startedAt,
      name: error instanceof Error ? error.name : "Error",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function probeParams(url: URL): {
  provider: "workers-ai" | "anthropic";
  modelId: string;
} {
  const provider =
    url.searchParams.get("provider") === "anthropic"
      ? "anthropic"
      : "workers-ai";
  const modelId =
    url.searchParams.get("model") ??
    (provider === "anthropic"
      ? DEFAULT_ANTHROPIC_MODEL
      : DEFAULT_WORKERS_AI_MODEL);
  return { provider, modelId };
}

/** A finalized chat turn, recorded from `onChatResponse`. */
type TurnRecord = {
  at: number;
  requestId: string;
  continuation: boolean;
  status: "completed" | "error" | "aborted";
  error?: string;
  textLength: number;
};

/** A per-turn error, recorded from `onChatError`. */
type ChatErrorRecord = {
  at: number;
  requestId?: string;
  stage: string;
  messagesPersisted?: boolean;
  name: string;
  message: string;
};

/** An agent-level error, recorded from `onError`. */
type AgentErrorRecord = {
  at: number;
  name: string;
  message: string;
};

type RecoveryContextRecord = {
  at: number;
  incidentId: string;
  streamId: string;
  requestId: string;
  attempt: number;
  maxAttempts: number;
  recoveryKind: "retry" | "continue";
  partialTextLength: number;
};

type ChatRecoveryIncidentRecord = {
  incidentId: string;
  requestId: string;
  recoveryKind: string;
  attempt: number;
  maxAttempts: number;
  status: string;
  firstSeenAt: number;
  lastAttemptAt: number;
  reason?: string;
};

const TURNS_KEY = "harness:turns";
const CHAT_ERRORS_KEY = "harness:chat-errors";
const AGENT_ERRORS_KEY = "harness:agent-errors";
const RECOVERY_CONTEXTS_KEY = "harness:recovery-contexts";
const EXHAUSTED_KEY = "harness:exhausted";
const CHAT_RECOVERY_INCIDENT_KEY_PREFIX = "cf:chat-recovery:incident:";

// Tool-rollback mode (real models + a non-idempotent tool). Config lives in a
// SQL table because `getModel()`/`getTools()` are synchronous and must observe
// the same provider/mode on a FRESH isolate (e.g. a recovery continuation after
// a deploy) — `this.sql` is a synchronous, durable read.
const DEFAULT_TOOL_STEPS = 24;

const DEFAULT_DURATION_SECONDS = 90;
const CHUNK_INTERVAL_MS = 1_000;
const MAX_RECORDS = 200;

function parseDurationSeconds(text: string): number {
  const match = text.match(/(\d{1,4})\s*(s|sec|secs|second|seconds)?\b/i);
  if (!match) return DEFAULT_DURATION_SECONDS;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_DURATION_SECONDS;
  return Math.min(value, 600);
}

/**
 * Deterministic slow model: streams one chunk per second for `seconds`, so a
 * deploy reliably lands mid-turn. No LLM, no tokens, no flakiness.
 */
function createSlowMockModel(seconds: number): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "deploy-churn",
    modelId: "mock-slow",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented");
    },
    doStream() {
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t" });
          for (let i = 0; i < seconds; i++) {
            await new Promise((r) => setTimeout(r, CHUNK_INTERVAL_MS));
            controller.enqueue({
              type: "text-delta",
              id: "t",
              delta: `[${i + 1}/${seconds}] `
            });
          }
          controller.enqueue({ type: "text-end", id: "t" });
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 10, outputTokens: seconds }
          });
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

/**
 * Streams a couple chunks then errors mid-stream — used to produce a terminal
 * *error* turn on demand (send a message containing "fail") so the silent /
 * frozen-after-reconnect behavior (Issue 4) can be observed in a browser.
 */
function createFailingModel(): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "deploy-churn",
    modelId: "mock-failing",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented");
    },
    doStream() {
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t" });
          controller.enqueue({
            type: "text-delta",
            id: "t",
            delta: "Working on it"
          });
          await new Promise((r) => setTimeout(r, 600));
          controller.error(new Error("Simulated model failure (harness)"));
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

export class DeployChurnAgent extends Think<Env> {
  // Wake quickly after eviction so alarm-driven recovery is observable.
  static options = { keepAliveIntervalMs: 5_000 };

  // In-memory guard: CREATE TABLE runs once per isolate.
  private _tableReady = false;

  override chatRecovery: ChatRecoveryConfig = {
    maxAttempts: 6,
    onExhausted: (ctx: ChatRecoveryExhaustedContext) => {
      this.log("recovery:exhausted", {
        incidentId: ctx.incidentId,
        requestId: ctx.requestId,
        attempt: ctx.attempt,
        maxAttempts: ctx.maxAttempts,
        recoveryKind: ctx.recoveryKind,
        reason: ctx.reason
      });
      void this.ctx.storage.put(EXHAUSTED_KEY, {
        at: Date.now(),
        incidentId: ctx.incidentId,
        requestId: ctx.requestId,
        attempt: ctx.attempt,
        maxAttempts: ctx.maxAttempts,
        reason: ctx.reason
      });
    }
  };

  // Allow a long, many-step tool loop so deploys can land between tool
  // settlements (the window where a lost tool result forces a re-run).
  override maxSteps = 80;

  override getModel(): LanguageModel {
    // Tool-rollback mode: use a REAL model (Workers AI or Anthropic) so the
    // agentic loop actually settles tool results that recovery must preserve.
    if (this._harnessMode() === "tools") return this._realModel();

    const lastUser = [...this.messages]
      .reverse()
      .find((m: UIMessage) => m.role === "user");
    const text = lastUser
      ? lastUser.parts
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join(" ")
      : "";
    if (/\bfail\b/i.test(text)) return createFailingModel();
    return createSlowMockModel(parseDurationSeconds(text));
  }

  override getSystemPrompt(): string {
    if (this._harnessMode() === "tools") {
      const steps = this._toolSteps();
      return [
        "You are a deploy-churn durability probe.",
        `Call the \`recordStep\` tool exactly once for each integer index from 1 to ${steps}, strictly in ascending order.`,
        "Make ONE tool call per step and wait for its result before the next. Never call an index you have already recorded, and never skip one.",
        "When you have recorded every index from 1 to " +
          steps +
          ", reply with the single word DONE and stop."
      ].join("\n");
    }
    return "Deploy-churn harness agent. Streams a deterministic slow response so a deploy can interrupt it.";
  }

  /**
   * The non-idempotent tool whose re-execution after a deploy is the
   * "rollback" we are hunting. Every EXECUTION appends a ledger row; a
   * completed step that re-runs (because its settled result was lost on a
   * superseded isolate) shows up as a DUPLICATE row for the same index.
   */
  override getTools(): ToolSet {
    if (this._harnessMode() !== "tools") return {};
    return {
      recordStep: tool({
        description:
          "Record that you have reached a given step index. Call once per index, in order.",
        inputSchema: jsonSchema<{ index: number }>({
          type: "object",
          properties: {
            index: { type: "number", description: "The step index (1-based)." }
          },
          required: ["index"],
          additionalProperties: false
        }),
        execute: async ({ index }, opts) => {
          this._ensureLedgerTable();
          const toolCallId =
            (opts as { toolCallId?: string } | undefined)?.toolCallId ?? null;
          this.sql`
            INSERT INTO harness_ledger (idx, tool_call_id, at)
            VALUES (${index}, ${toolCallId}, ${Date.now()})
          `;
          // Configurable in-flight window. A large delay (e.g. 12s) makes a real
          // ~33s `wrangler deploy` reliably land DURING a tool execution, so we
          // exercise the code-update reset mid-tool (not just between tools).
          const delayMs = Number(this._harnessConfig("stepDelayMs")) || 250;
          await new Promise((r) => setTimeout(r, delayMs));
          const total =
            this.sql<{ c: number }>`SELECT COUNT(*) AS c FROM harness_ledger`[0]
              ?.c ?? 0;
          this.log("tool:recordStep", { index, totalExecutions: total });
          return { recorded: index, totalExecutions: total };
        }
      })
    };
  }

  /** Single structured log line per event — queryable via tail / observability. */
  private log(event: string, data: Record<string, unknown> = {}): void {
    console.log(
      JSON.stringify({
        kind: "deploy-churn",
        event,
        agent: this.name,
        ts: Date.now(),
        iso: new Date().toISOString(),
        ...data
      })
    );
  }

  private async append<T>(key: string, entry: T): Promise<void> {
    const list = (await this.ctx.storage.get<T[]>(key)) ?? [];
    list.push(entry);
    if (list.length > MAX_RECORDS) list.splice(0, list.length - MAX_RECORDS);
    await this.ctx.storage.put(key, list);
  }

  // ── Tool-rollback config (synchronous, durable, survives a deploy) ──────────

  private _ensureHarnessConfigTable(): void {
    this
      .sql`CREATE TABLE IF NOT EXISTS harness_config (key TEXT PRIMARY KEY, value TEXT)`;
  }

  private _harnessConfig(key: string): string | null {
    this._ensureHarnessConfigTable();
    const rows = this.sql<{ value: string }>`
      SELECT value FROM harness_config WHERE key = ${key}
    `;
    return rows[0]?.value ?? null;
  }

  private _setHarnessConfig(key: string, value: string): void {
    this._ensureHarnessConfigTable();
    this.sql`
      INSERT INTO harness_config (key, value) VALUES (${key}, ${value})
      ON CONFLICT(key) DO UPDATE SET value = ${value}
    `;
  }

  private _harnessMode(): "mock" | "tools" {
    return this._harnessConfig("mode") === "tools" ? "tools" : "mock";
  }

  private _harnessProvider(): Provider {
    return this._harnessConfig("provider") === "anthropic"
      ? "anthropic"
      : "workers-ai";
  }

  private _toolSteps(): number {
    const raw = Number(this._harnessConfig("steps"));
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TOOL_STEPS;
  }

  private _realModel(): LanguageModel {
    const provider = this._harnessProvider();
    if (provider === "anthropic") {
      const key = this.env.ANTHROPIC_API_KEY;
      if (!key) {
        throw new Error(
          "ANTHROPIC_API_KEY not set (wrangler secret put ANTHROPIC_API_KEY)"
        );
      }
      const modelId = this._harnessConfig("model") ?? DEFAULT_ANTHROPIC_MODEL;
      return createAnthropic({ apiKey: key })(modelId);
    }
    const modelId = this._harnessConfig("model") ?? DEFAULT_WORKERS_AI_MODEL;
    return createWorkersAI({ binding: this.env.AI })(modelId);
  }

  private _ensureLedgerTable(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS harness_ledger (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        idx INTEGER,
        tool_call_id TEXT,
        at INTEGER
      )
    `;
  }

  // ── Turn lifecycle ────────────────────────────────────────────────────────

  /**
   * Durable SQL write on every streamed chunk. This is the load-bearing detail
   * for the report's failure mode: the recovery continuation (`continueLastTurn`)
   * re-runs the turn, so these writes also fire during the recovery alarm. When
   * a deploy resets the isolate mid-stream, an in-flight SQL write throws
   * "Durable Object reset because its code was updated" — exactly the
   * `.alarm → .sql` stack from the report — which surfaces via `onChatError`
   * (stage "stream"/"recovery") instead of a clean skip.
   */
  override onChunk(ctx: ChunkContext): void {
    if (ctx.chunk.type !== "text-delta") return;
    if (!this._tableReady) {
      this
        .sql`CREATE TABLE IF NOT EXISTS harness_chunks (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, delta TEXT)`;
      this._tableReady = true;
    }
    this
      .sql`INSERT INTO harness_chunks (at, delta) VALUES (${Date.now()}, ${ctx.chunk.text})`;
  }

  override async onChatResponse(result: ChatResponseResult): Promise<void> {
    const textLength = result.message.parts
      .filter((p) => p.type === "text")
      .reduce((n, p) => n + (p as { text: string }).text.length, 0);
    await this.append<TurnRecord>(TURNS_KEY, {
      at: Date.now(),
      requestId: result.requestId,
      continuation: result.continuation,
      status: result.status,
      error: result.error,
      textLength
    });
    this.log("turn:response", {
      requestId: result.requestId,
      continuation: result.continuation,
      status: result.status,
      error: result.error
    });
  }

  // ── Error capture (the whole point) ─────────────────────────────────────────

  /** Per-turn errors, tagged with the failure stage (incl. "recovery"). */
  override onChatError(error: unknown, ctx?: ChatErrorContext): unknown {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    this.log("error:chat", {
      stage: ctx?.stage,
      requestId: ctx?.requestId,
      messagesPersisted: ctx?.messagesPersisted,
      name,
      message
    });
    void this.append<ChatErrorRecord>(CHAT_ERRORS_KEY, {
      at: Date.now(),
      requestId: ctx?.requestId,
      stage: ctx?.stage ?? "unknown",
      messagesPersisted: ctx?.messagesPersisted,
      name,
      message
    });
    // Propagate unchanged so default terminal handling still runs.
    return error;
  }

  /** Agent-level errors (scheduled callback dispatch, scheduled tasks). */
  override async onError(error: unknown): Promise<void> {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    this.log("error:agent", { name, message });
    await this.append<AgentErrorRecord>(AGENT_ERRORS_KEY, {
      at: Date.now(),
      name,
      message
    });
  }

  // ── Recovery ────────────────────────────────────────────────────────────────

  override async onChatRecovery(
    ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions> {
    await this.append<RecoveryContextRecord>(RECOVERY_CONTEXTS_KEY, {
      at: Date.now(),
      incidentId: ctx.incidentId,
      streamId: ctx.streamId,
      requestId: ctx.requestId,
      attempt: ctx.attempt,
      maxAttempts: ctx.maxAttempts,
      recoveryKind: ctx.recoveryKind,
      partialTextLength: ctx.partialText.length
    });
    this.log("recovery:detected", {
      incidentId: ctx.incidentId,
      requestId: ctx.requestId,
      attempt: ctx.attempt,
      maxAttempts: ctx.maxAttempts,
      recoveryKind: ctx.recoveryKind,
      partialTextLength: ctx.partialText.length
    });
    // Defaults: persist the partial message and schedule a continuation.
    return {};
  }

  // ── Inspection RPCs (read by the orchestrator over WebSocket) ───────────────

  @callable()
  async getStatus(): Promise<{
    name: string;
    messageCount: number;
    assistantMessages: number;
    turns: TurnRecord[];
    chatErrors: ChatErrorRecord[];
    agentErrors: AgentErrorRecord[];
    recoveryContexts: RecoveryContextRecord[];
    incidents: ChatRecoveryIncidentRecord[];
    exhausted: unknown;
    hasFiberRows: boolean;
    chunkWrites: number;
  }> {
    const [turns, chatErrors, agentErrors, recoveryContexts, exhausted] =
      await Promise.all([
        this.ctx.storage.get<TurnRecord[]>(TURNS_KEY),
        this.ctx.storage.get<ChatErrorRecord[]>(CHAT_ERRORS_KEY),
        this.ctx.storage.get<AgentErrorRecord[]>(AGENT_ERRORS_KEY),
        this.ctx.storage.get<RecoveryContextRecord[]>(RECOVERY_CONTEXTS_KEY),
        this.ctx.storage.get(EXHAUSTED_KEY)
      ]);
    const assistantMsgs = this.messages.filter(
      (m: UIMessage) => m.role === "assistant"
    );
    return {
      name: this.name,
      messageCount: this.messages.length,
      assistantMessages: assistantMsgs.length,
      turns: turns ?? [],
      chatErrors: chatErrors ?? [],
      agentErrors: agentErrors ?? [],
      recoveryContexts: recoveryContexts ?? [],
      incidents: await this._listIncidents(),
      exhausted: exhausted ?? null,
      hasFiberRows: this._hasFiberRows(),
      chunkWrites: this._chunkWrites()
    };
  }

  @callable()
  async getErrors(): Promise<{
    chatErrors: ChatErrorRecord[];
    agentErrors: AgentErrorRecord[];
  }> {
    return {
      chatErrors:
        (await this.ctx.storage.get<ChatErrorRecord[]>(CHAT_ERRORS_KEY)) ?? [],
      agentErrors:
        (await this.ctx.storage.get<AgentErrorRecord[]>(AGENT_ERRORS_KEY)) ?? []
    };
  }

  @callable()
  hasFiberRows(): boolean {
    return this._hasFiberRows();
  }

  @callable()
  async reset(): Promise<{ ok: true }> {
    for (const key of [
      TURNS_KEY,
      CHAT_ERRORS_KEY,
      AGENT_ERRORS_KEY,
      RECOVERY_CONTEXTS_KEY,
      EXHAUSTED_KEY
    ]) {
      await this.ctx.storage.delete(key);
    }
    const incidents = await this._listIncidents();
    for (const incident of incidents) {
      await this.ctx.storage.delete(
        `${CHAT_RECOVERY_INCIDENT_KEY_PREFIX}${encodeURIComponent(incident.incidentId)}`
      );
    }
    // Wipe submissions, the tool ledger, and tool config so a fresh run starts
    // from zero. (Each orchestrator run also uses a fresh session/DO instance,
    // so the durable transcript starts empty too.)
    await this.deleteSubmissions();
    this._ensureLedgerTable();
    this.sql`DELETE FROM harness_ledger`;
    this._ensureHarnessConfigTable();
    this.sql`DELETE FROM harness_config`;
    this.log("harness:reset", { clearedIncidents: incidents.length });
    return { ok: true };
  }

  /**
   * HTTP/RPC entry point for the tool-rollback probe: switch the agent to a
   * REAL model + the non-idempotent `recordStep` tool, then kick off a durable
   * background turn via `submitMessages` (survives disconnects and deploys).
   * The turn asks the model to record N steps in order; a deploy mid-loop tests
   * whether already-settled steps survive recovery or get rolled back & re-run.
   */
  @callable()
  async startToolRun(
    provider: Provider = "workers-ai",
    steps: number = DEFAULT_TOOL_STEPS,
    model?: string,
    stepDelayMs?: number
  ): Promise<{ submissionId: string; provider: Provider; steps: number }> {
    const stepCount =
      Number.isFinite(steps) && steps > 0
        ? Math.min(Math.floor(steps), 200)
        : DEFAULT_TOOL_STEPS;
    this._setHarnessConfig("mode", "tools");
    this._setHarnessConfig("provider", provider);
    this._setHarnessConfig("steps", String(stepCount));
    if (model) this._setHarnessConfig("model", model);
    if (stepDelayMs && Number.isFinite(stepDelayMs) && stepDelayMs > 0) {
      this._setHarnessConfig("stepDelayMs", String(Math.floor(stepDelayMs)));
    }
    this._ensureLedgerTable();

    const submissionId = crypto.randomUUID();
    await this.submitMessages(
      [
        {
          id: `user-${Date.now()}`,
          role: "user",
          parts: [
            {
              type: "text",
              text: `Record steps 1 through ${stepCount} in order using the recordStep tool, one per step.`
            }
          ]
        }
      ],
      { submissionId }
    );
    this.log("tool:run:start", { provider, steps: stepCount, submissionId });
    return { submissionId, provider, steps: stepCount };
  }

  @callable()
  async getToolStatus(): Promise<{
    mode: string;
    provider: string;
    steps: number;
    ledger: {
      totalExecutions: number;
      uniqueIndices: number;
      duplicateIndices: Array<{ index: number; executions: number }>;
      maxIndex: number;
    };
    transcriptToolCalls: number;
    submissions: ThinkSubmissionInspection[];
    turns: TurnRecord[];
    chatErrors: ChatErrorRecord[];
    agentErrors: AgentErrorRecord[];
    incidents: ChatRecoveryIncidentRecord[];
    exhausted: unknown;
    hasFiberRows: boolean;
    assistantMessages: number;
  }> {
    const [turns, chatErrors, agentErrors, exhausted] = await Promise.all([
      this.ctx.storage.get<TurnRecord[]>(TURNS_KEY),
      this.ctx.storage.get<ChatErrorRecord[]>(CHAT_ERRORS_KEY),
      this.ctx.storage.get<AgentErrorRecord[]>(AGENT_ERRORS_KEY),
      this.ctx.storage.get(EXHAUSTED_KEY)
    ]);
    return {
      mode: this._harnessMode(),
      provider: this._harnessProvider(),
      steps: this._toolSteps(),
      ledger: this._ledgerSummary(),
      transcriptToolCalls: this._transcriptToolCalls(),
      submissions: await this.listSubmissions(),
      turns: turns ?? [],
      chatErrors: chatErrors ?? [],
      agentErrors: agentErrors ?? [],
      incidents: await this._listIncidents(),
      exhausted: exhausted ?? null,
      hasFiberRows: this._hasFiberRows(),
      assistantMessages: this.messages.filter(
        (m: UIMessage) => m.role === "assistant"
      ).length
    };
  }

  private _ledgerSummary(): {
    totalExecutions: number;
    uniqueIndices: number;
    duplicateIndices: Array<{ index: number; executions: number }>;
    maxIndex: number;
  } {
    try {
      const rows = this.sql<{ idx: number; executions: number }>`
        SELECT idx, COUNT(*) AS executions
        FROM harness_ledger
        GROUP BY idx
        ORDER BY idx ASC
      `;
      const totalExecutions = rows.reduce((n, r) => n + r.executions, 0);
      const duplicateIndices = rows
        .filter((r) => r.executions > 1)
        .map((r) => ({ index: r.idx, executions: r.executions }));
      const maxIndex = rows.reduce((m, r) => Math.max(m, r.idx), 0);
      return {
        totalExecutions,
        uniqueIndices: rows.length,
        duplicateIndices,
        maxIndex
      };
    } catch {
      return {
        totalExecutions: 0,
        uniqueIndices: 0,
        duplicateIndices: [],
        maxIndex: 0
      };
    }
  }

  /** Count `recordStep` tool calls visible in the final durable transcript. */
  private _transcriptToolCalls(): number {
    let count = 0;
    for (const message of this.messages) {
      for (const part of message.parts) {
        const type = (part as { type?: string }).type;
        if (typeof type === "string" && type.startsWith("tool-")) count++;
      }
    }
    return count;
  }

  private _hasFiberRows(): boolean {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_runs
    `;
    return (rows[0]?.count ?? 0) > 0;
  }

  private _chunkWrites(): number {
    try {
      const rows = this.sql<{ count: number }>`
        SELECT COUNT(*) as count FROM harness_chunks
      `;
      return rows[0]?.count ?? 0;
    } catch {
      return 0;
    }
  }

  private async _listIncidents(): Promise<ChatRecoveryIncidentRecord[]> {
    const map = await this.ctx.storage.list<ChatRecoveryIncidentRecord>({
      prefix: CHAT_RECOVERY_INCIDENT_KEY_PREFIX
    });
    return [...map.values()].sort((a, b) => a.firstSeenAt - b.firstSeenAt);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Prefill-rejection probe: does the model reject a transcript that ends in
    // an assistant message (what recovery's continuation replays)? Defaults to
    // Workers AI / Kimi; pass ?provider=anthropic&model=claude-sonnet-4-6.
    if (url.pathname === "/probe/trailing-assistant") {
      const { provider, modelId } = probeParams(url);
      return Response.json(
        await probeTrailingRole(env, "assistant", provider, modelId)
      );
    }
    if (url.pathname === "/probe/trailing-user") {
      const { provider, modelId } = probeParams(url);
      return Response.json(
        await probeTrailingRole(env, "user", provider, modelId)
      );
    }

    // ── Tool-rollback driver (plain HTTP — no browser, no WebSocket) ──────────
    // Drives a durable tool-using turn via `submitMessages` and reads the
    // rollback ledger, so the orchestrator can run real deploys against a long
    // session and check whether completed tool calls get re-run.
    if (url.pathname.startsWith("/drive/")) {
      const session = url.searchParams.get("session") ?? "default";
      const stub = await getAgentByName(env.DeployChurnAgent, session);

      if (url.pathname === "/drive/start" && request.method === "POST") {
        const provider: Provider =
          url.searchParams.get("provider") === "anthropic"
            ? "anthropic"
            : "workers-ai";
        const steps = Number(url.searchParams.get("steps") ?? "") || undefined;
        const model = url.searchParams.get("model") ?? undefined;
        const delayMs =
          Number(url.searchParams.get("delayMs") ?? "") || undefined;
        return Response.json(
          await stub.startToolRun(provider, steps, model, delayMs)
        );
      }
      if (url.pathname === "/drive/status") {
        return Response.json(await stub.getToolStatus());
      }
      if (url.pathname === "/drive/reset" && request.method === "POST") {
        return Response.json(await stub.reset());
      }
      return new Response("Not found", { status: 404 });
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
