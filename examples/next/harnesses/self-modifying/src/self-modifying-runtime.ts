import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { Workspace } from "@cloudflare/shell";
import type {
  HarnessDriveContext,
  HarnessEventBody,
  HarnessRuntimeMessagePage,
  HarnessMessagesOptions,
  HarnessOperationHandle,
  HarnessPromptPayload,
  HarnessRuntime,
  HarnessRuntimeStartContext
} from "@cloudflare/agents-next-harness";
import {
  compileHarness,
  HarnessBuildError,
  runHarnessTurn
} from "./harness-runtime";
import { HarnessSource } from "./harness-source";
import { SelfModifyingTurnHost } from "./host-bridge";
import type {
  HarnessActivation,
  HarnessEventSink,
  HarnessJournalSink,
  HarnessSourceOperations,
  HarnessTurnEvent
} from "./host-bridge";
import { toJsonValue } from "./json";
import type { JsonObject, JsonValue } from "./json";
import type {
  SelfModifyingErrorCode,
  SelfModifyingProtocol,
  SelfModifyingResult,
  SelfModifyingSnapshot
} from "./protocol";
import type { HarnessTurnResult } from "./runtime-types";
import { SEED_HARNESS_FILES } from "./seed";
import { SelfModifyingHarnessStore } from "./store";
import type {
  HarnessBuild,
  HarnessRevision,
  SelfModifyingOperation
} from "./store";

/** The inbox kinds this runtime consumes, in the order it takes them. */
const DRIVEN_KINDS = ["prompt", "activate", "restore", "write_source"] as const;
const DEFAULT_MESSAGE_BYTES = 262_144;

type DrivenKind = (typeof DRIVEN_KINDS)[number];

/** The durable outcome of one pinned turn, journaled by `ctx.step.do`. */
type TurnOutcome =
  | {
      readonly status: "completed";
      readonly output: string;
      readonly rounds: number;
      readonly isolateRun: number;
    }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "aborted" };

/** A payload the browser sent that this runtime cannot act on. */
export class SelfModifyingInputError extends Error {
  readonly _tag = "SelfModifyingInputError" as const;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The phase a failed operation settles with, as `HarnessResult.error.code`. */
function errorCode(
  error: unknown,
  fallback: SelfModifyingErrorCode
): SelfModifyingErrorCode {
  return error instanceof HarnessBuildError ? error.phase : fallback;
}

function isDrivenKind(kind: string): kind is DrivenKind {
  return (DRIVEN_KINDS as readonly string[]).includes(kind);
}

function record(value: unknown, label: string): { [key: string]: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SelfModifyingInputError(`${label} must be an object`);
  }
  // SAFETY: the branch above narrowed the value to a non-null, non-array
  // object; every field this module reads is checked before it is used.
  return value as { [key: string]: unknown };
}

function stringField(value: JsonValue, key: string, label: string): string {
  const field = record(value, label)[key];
  if (typeof field !== "string") {
    throw new SelfModifyingInputError(`${label}.${key} must be a string`);
  }
  return field;
}

function promptText(payload: JsonValue): string {
  // SAFETY: the base writes `HarnessPromptPayload` into every prompt row.
  const input = (payload as unknown as HarnessPromptPayload).input;
  const text =
    typeof input === "string"
      ? input
      : (input?.text ??
        (input?.parts ?? [])
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n"));
  if (text.trim() === "") {
    throw new SelfModifyingInputError("Turn prompt must not be empty");
  }
  return text;
}

function revisionIdField(payload: JsonValue): number {
  const field = record(payload, "restore")["revisionId"];
  if (typeof field !== "number" || !Number.isSafeInteger(field)) {
    throw new SelfModifyingInputError("restore.revisionId must be an integer");
  }
  return field;
}

function bytesOf(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

function buildErrorData(error: unknown): JsonObject {
  if (error instanceof HarnessBuildError) {
    return { tag: error._tag, phase: error.phase, message: error.message };
  }
  return { tag: "UnknownBuildError", message: errorMessage(error) };
}

/** Project one host-bridge event onto the frame the shared UI renders. */
function turnFrame(
  event: HarnessTurnEvent
): HarnessEventBody<SelfModifyingProtocol> {
  switch (event.type) {
    case "tool_started":
      return {
        type: "tool_start",
        toolCallId: event.callId,
        toolName: event.name,
        input: event.input
      };
    case "tool_completed":
    case "tool_failed":
      return {
        type: "tool_end",
        toolCallId: event.callId,
        output: event.result,
        isError: event.type === "tool_failed"
      };
    default:
      return { type: "extension", body: event };
  }
}

function parseOutcome(value: unknown): TurnOutcome {
  const outcome = record(value, "turn outcome");
  if (outcome["status"] === "aborted") return { status: "aborted" };
  if (outcome["status"] === "failed" && typeof outcome["error"] === "string") {
    return { status: "failed", error: outcome["error"] };
  }
  if (
    outcome["status"] !== "completed" ||
    typeof outcome["output"] !== "string" ||
    typeof outcome["rounds"] !== "number" ||
    typeof outcome["isolateRun"] !== "number"
  ) {
    throw new SelfModifyingInputError("Stored turn outcome is invalid");
  }
  return {
    status: "completed",
    output: outcome["output"],
    rounds: outcome["rounds"],
    isolateRun: outcome["isolateRun"]
  };
}

/** Configuration for the self-modifying runtime. */
export type SelfModifyingRuntimeOptions = {
  readonly workspace: Workspace;
  readonly loader: WorkerLoader;
  readonly model: LanguageModelV4;
};

/**
 * A `HarnessRuntime` whose agent loop is itself editable.
 *
 * Prompts run the pinned compiled revision in a fresh Dynamic Worker;
 * `activate`, `restore` and `write_source` submissions change the source
 * the next turn runs. Editable code only ever sees a per-turn
 * {@link SelfModifyingTurnHost} RPC target, never storage or bindings.
 */
export class SelfModifyingRuntime implements HarnessRuntime<SelfModifyingProtocol> {
  readonly id = "in-do:self-modifying";
  readonly capabilities = new Set(["workspace"] as const);

  readonly #source: HarnessSource;
  readonly #loader: WorkerLoader;
  readonly #model: LanguageModelV4;
  #storeInstance: SelfModifyingHarnessStore | undefined;
  #sourceOperation: Promise<void> = Promise.resolve();

  constructor(options: SelfModifyingRuntimeOptions) {
    this.#source = new HarnessSource(options.workspace);
    this.#loader = options.loader;
    this.#model = options.model;
  }

  /** Create the trusted tables and compile the genesis source once. */
  async onStart(ctx: HarnessRuntimeStartContext): Promise<void> {
    const store = new SelfModifyingHarnessStore(ctx.storage);
    this.#storeInstance = store;
    store.ensureSchema();
    const journal = this.#journalSink(null);
    const active = store.activeBuild();
    if (active) {
      await this.#withSourceLock(() => this.#source.seed(active.source));
      return;
    }
    const seeded = await this.#withSourceLock(() =>
      this.#source.seed(SEED_HARNESS_FILES)
    );
    if (!seeded) journal("genesis_source_reused", {});
    await this.#activate("genesis", "genesis", journal);
  }

  /** Take prompts and source operations from the inbox, oldest first. */
  async drive(ctx: HarnessDriveContext<SelfModifyingProtocol>): Promise<void> {
    // An operation already marked running lost its admission row when it
    // began: its input is replayed from the runtime's own record.
    const running = ctx.active();
    if (running) await this.#resume(ctx, running.operationId);
    for (;;) {
      const head = ctx.inbox.peek({ kinds: [...DRIVEN_KINDS], limit: 1 })[0];
      if (!head || head.operationId === null) return;
      if (!isDrivenKind(head.kind)) return;
      // The base hands out read-only JSON; the editable side of this example
      // speaks the plain JSON shape its RPC boundary uses.
      await this.#run(
        ctx,
        head.kind,
        head.operationId,
        toJsonValue(head.payload)
      );
    }
  }

  /** The transcript the base serves: one user and one assistant message per turn. */
  messages(
    _sessionId: string,
    options: HarnessMessagesOptions
  ): Promise<HarnessRuntimeMessagePage> {
    const messages = this.#store.transcript(
      options.maxBytes ?? DEFAULT_MESSAGE_BYTES
    );
    return Promise.resolve({ messages });
  }

  /** Active revision, its exact source, the revision list and the journal. */
  snapshot(): SelfModifyingSnapshot {
    const active = this.#store.activeBuild();
    if (!active) throw new Error("Harness genesis has not been activated");
    return {
      active: {
        revisionId: active.revisionId,
        sourceHash: active.sourceHash,
        parentRevisionId: active.parentRevisionId,
        note: active.note,
        createdAt: active.createdAt
      },
      files: Object.entries(active.source)
        .map(([path, content]) => ({
          path,
          size: bytesOf(content),
          content
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
      revisions: this.#store.revisions(),
      journal: this.#store.journalTail()
    };
  }

  /** One recorded operation: its pinned revision and isolate metrics. */
  operation(operationId: string): SelfModifyingOperation | null {
    return this.#store.operation(operationId);
  }

  get #store(): SelfModifyingHarnessStore {
    if (!this.#storeInstance) {
      throw new Error("The self-modifying runtime has not started");
    }
    return this.#storeInstance;
  }

  // ── Driving ──────────────────────────────────────────────────────────────

  async #resume(
    ctx: HarnessDriveContext<SelfModifyingProtocol>,
    operationId: string
  ): Promise<void> {
    const pending = this.#store.operation(operationId);
    if (pending && isDrivenKind(pending.kind)) {
      await this.#run(ctx, pending.kind, operationId, pending.payload);
      return;
    }
    await ctx.settle(operationId, {
      status: "failed",
      stopReason: { type: "runtime_lost" },
      error: {
        code: "lost",
        message: `Operation ${operationId} has no replayable input`
      }
    });
  }

  #run(
    ctx: HarnessDriveContext<SelfModifyingProtocol>,
    kind: DrivenKind,
    operationId: string,
    payload: JsonValue
  ): Promise<void> {
    return kind === "prompt"
      ? this.#runTurn(ctx, operationId, payload)
      : this.#runSourceOperation(ctx, kind, operationId, payload);
  }

  /** Run one prompt on the revision pinned when it started. */
  async #runTurn(
    ctx: HarnessDriveContext<SelfModifyingProtocol>,
    operationId: string,
    payload: JsonValue
  ): Promise<void> {
    // Recorded before `begin()` consumes the admission row, so an evicted
    // isolate can replay this turn from the runtime's own record.
    const prepared = this.#prepareTurn(operationId, payload);
    const op = await ctx.begin(operationId);
    if ("error" in prepared) {
      await ctx.settle(operationId, {
        status: "failed",
        stopReason: { type: "error", raw: "turn" },
        error: { code: "turn", message: prepared.error }
      });
      return;
    }
    const { prompt, revisionId } = prepared;
    const messageId = `assistant:${operationId}`;
    if (this.#store.claimStreamEvent(operationId, "turn:start")) {
      op.append({ type: "message_start", messageId, role: "assistant" });
    }
    const outcome = await this.#pinnedTurnStep(ctx, {
      operationId,
      prompt,
      revisionId,
      events: this.#eventSink(
        operationId,
        op,
        messageId,
        this.#journalSink(operationId, op)
      )
    });
    await this.#settleTurn(ctx, op, {
      operationId,
      messageId,
      revisionId,
      outcome
    });
  }

  /** Pin the active revision and record the turn's user message. */
  #prepareTurn(
    operationId: string,
    payload: JsonValue
  ):
    | { readonly prompt: string; readonly revisionId: number }
    | { readonly error: string } {
    try {
      const prompt = promptText(payload);
      const active = this.#store.activeBuild();
      if (!active) throw new Error("Harness genesis has not been activated");
      this.#store.beginOperation({
        operationId,
        kind: "prompt",
        payload,
        revisionId: active.revisionId,
        prompt
      });
      return {
        prompt,
        // A replayed turn keeps the revision it was admitted against.
        revisionId:
          this.#store.operation(operationId)?.revisionId ?? active.revisionId
      };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }

  /** The turn itself, journaled so an evicted isolate replays its outcome. */
  async #pinnedTurnStep(
    ctx: HarnessDriveContext<SelfModifyingProtocol>,
    input: {
      readonly operationId: string;
      readonly prompt: string;
      readonly revisionId: number;
      readonly events: HarnessEventSink;
    }
  ): Promise<TurnOutcome> {
    const interrupted = ctx.interrupted(input.operationId);
    // Harness failures settle inside the step so they journal as the turn's
    // durable outcome. Only Tasks control signals (retry suspension, cancel,
    // a superseded attempt) leave `step.do`, and they must keep propagating.
    const outcome = await ctx.step.do<TurnOutcome>(
      `run-editable-harness:${input.operationId}`,
      { timeout: "5 minutes", retries: { limit: 2, delay: "5 seconds" } },
      async (): Promise<TurnOutcome> => {
        const running = this.#runPinnedTurn(input, input.events);
        // The interrupt path stops awaiting the isolate; its later failure
        // must not surface as an unhandled rejection.
        running.catch(() => undefined);
        try {
          return await Promise.race<TurnOutcome>([
            running.then((result) => ({
              status: "completed",
              output: result.output,
              rounds: result.rounds,
              isolateRun: result.isolateRun
            })),
            aborts(interrupted)
          ]);
        } catch (error) {
          return { status: "failed", error: errorMessage(error) };
        }
      }
    );
    return parseOutcome(outcome);
  }

  async #settleTurn(
    ctx: HarnessDriveContext<SelfModifyingProtocol>,
    op: HarnessOperationHandle<SelfModifyingProtocol>,
    turn: {
      readonly operationId: string;
      readonly messageId: string;
      readonly revisionId: number;
      readonly outcome: TurnOutcome;
    }
  ): Promise<void> {
    const { operationId, messageId, revisionId, outcome } = turn;
    const end = (text: string): void =>
      op.append({
        type: "message_end",
        messageId,
        role: "assistant",
        parts: [{ type: "text", text }]
      });
    if (outcome.status === "completed") {
      this.#store.completeTurn(operationId, outcome);
      end(outcome.output);
      await ctx.settle(operationId, {
        status: "completed",
        stopReason: { type: "end_turn" },
        raw: { revisionId, output: outcome.output }
      });
      return;
    }
    if (outcome.status === "aborted") {
      this.#store.completeTurn(operationId, { output: "(interrupted)" });
      end("(interrupted)");
      await ctx.settle(operationId, {
        status: "aborted",
        stopReason: { type: "interrupted" },
        raw: { revisionId }
      });
      return;
    }
    op.append({
      type: "error",
      error: { code: "turn", message: outcome.error }
    });
    await ctx.settle(operationId, {
      status: "failed",
      stopReason: { type: "error", raw: "turn" },
      error: { code: "turn", message: outcome.error },
      raw: { revisionId }
    });
  }

  /** Run one source operation under the source lock. */
  async #runSourceOperation(
    ctx: HarnessDriveContext<SelfModifyingProtocol>,
    kind: Exclude<DrivenKind, "prompt">,
    operationId: string,
    payload: JsonValue
  ): Promise<void> {
    // Recorded before `begin()` consumes the admission row, so an evicted
    // isolate can replay this operation from the runtime's own record.
    this.#store.beginOperation({ operationId, kind, payload });
    const op = await ctx.begin(operationId);
    const journal = this.#journalSink(operationId, op);
    try {
      const raw = await this.#applySourceOperation(
        kind,
        operationId,
        payload,
        journal
      );
      await ctx.settle(operationId, {
        status: "completed",
        stopReason: { type: "end_turn" },
        raw
      });
    } catch (error) {
      const code = errorCode(error, "source");
      await ctx.settle(operationId, {
        status: "failed",
        stopReason: { type: "error", raw: code },
        error: { code, message: errorMessage(error) }
      });
    }
  }

  async #applySourceOperation(
    kind: Exclude<DrivenKind, "prompt">,
    operationId: string,
    payload: JsonValue,
    journal: HarnessJournalSink
  ): Promise<SelfModifyingResult> {
    if (kind === "activate") {
      const note = stringField(payload, "note", "activate");
      return {
        revision: await this.#activate(note, `activate:${operationId}`, journal)
      };
    }
    if (kind === "restore") {
      const revisionId = revisionIdField(payload);
      return {
        revision: await this.#restore(
          revisionId,
          `restore:${revisionId}:${operationId}`,
          journal
        )
      };
    }
    const path = stringField(payload, "path", "write_source");
    const content = stringField(payload, "content", "write_source");
    await this.#withSourceLock(async () => {
      await this.#source.write(path, content);
      journal("source_written", {
        path,
        bytes: bytesOf(content),
        source: "operator"
      });
    });
    return { path };
  }

  // ── Source and activation ────────────────────────────────────────────────

  #activate(
    note: string,
    activationKey: string,
    journal: HarnessJournalSink
  ): Promise<HarnessRevision> {
    return this.#withSourceLock(() =>
      this.#activateUnlocked(note, activationKey, journal)
    );
  }

  async #activateUnlocked(
    note: string,
    activationKey: string,
    journal: HarnessJournalSink
  ): Promise<HarnessRevision> {
    const replayed = this.#store.revisionByActivationKey(activationKey);
    if (replayed) return replayed;
    const source = await this.#source.snapshot();
    try {
      const compiled = await compileHarness(this.#loader, source);
      const revision = this.#store.activate({
        sourceHash: compiled.sourceHash,
        source,
        mainModule: compiled.mainModule,
        modules: compiled.modules,
        note: note.slice(0, 500),
        activationKey
      });
      journal(
        "harness_activated",
        {
          revisionId: revision.revisionId,
          parentRevisionId: revision.parentRevisionId,
          sourceHash: revision.sourceHash,
          name: compiled.manifest.name,
          version: compiled.manifest.version,
          note: revision.note
        },
        `activation:${activationKey}:completed`
      );
      return revision;
    } catch (error) {
      journal("harness_activation_failed", buildErrorData(error));
      throw error;
    }
  }

  /** Restore an activated snapshot and record it as a new forward revision. */
  async #restore(
    revisionId: number,
    activationKey: string,
    journal: HarnessJournalSink
  ): Promise<HarnessRevision> {
    const replayed = this.#store.revisionByActivationKey(activationKey);
    if (replayed) return replayed;
    const build = this.#store.build(revisionId);
    if (!build) {
      throw new SelfModifyingInputError(
        `Harness revision ${revisionId} was not found`
      );
    }
    return this.#withSourceLock(async () => {
      await this.#source.replace(build.source);
      journal("revision_source_restored", { fromRevisionId: revisionId });
      return this.#activateUnlocked(
        `restore revision ${revisionId}`,
        activationKey,
        journal
      );
    });
  }

  #withSourceLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#sourceOperation.then(operation, operation);
    this.#sourceOperation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  // ── The pinned isolate ───────────────────────────────────────────────────

  async #runPinnedTurn(
    input: {
      readonly operationId: string;
      readonly prompt: string;
      readonly revisionId: number;
    },
    events: HarnessEventSink
  ): Promise<HarnessTurnResult> {
    const build = this.#requireBuild(input.revisionId);
    const activation: HarnessActivation = {
      activate: (note, key) => this.#activate(note, key, events.journal),
      restore: (revisionId, key) =>
        this.#restore(revisionId, key, events.journal)
    };
    const source: HarnessSourceOperations = {
      read: (path) => this.#withSourceLock(() => this.#source.read(path)),
      write: (path, content) =>
        this.#withSourceLock(() => this.#source.write(path, content)),
      delete: (path) => this.#withSourceLock(() => this.#source.delete(path)),
      list: () => this.#withSourceLock(() => this.#source.list())
    };
    const host = new SelfModifyingTurnHost({
      operationId: input.operationId,
      source,
      store: this.#store,
      model: this.#model,
      activation,
      events
    });
    try {
      return await runHarnessTurn({
        loader: this.#loader,
        mainModule: build.mainModule,
        modules: build.modules,
        turn: {
          turnId: input.operationId,
          prompt: input.prompt,
          revisionId: input.revisionId,
          history: this.#store.historyBefore(input.operationId)
        },
        host
      });
    } finally {
      const disposable = host as { [Symbol.dispose]?: () => void };
      disposable[Symbol.dispose]?.();
    }
  }

  #requireBuild(revisionId: number): HarnessBuild {
    const build = this.#store.build(revisionId);
    if (!build) {
      throw new Error(`Pinned harness revision ${revisionId} was not found`);
    }
    return build;
  }

  // ── Frames ───────────────────────────────────────────────────────────────

  /**
   * Journal a trusted record and mirror it into the operation's log. The
   * event key makes both idempotent, so a replayed step appends nothing.
   */
  #journalSink(
    operationId: string | null,
    op?: HarnessOperationHandle<SelfModifyingProtocol>
  ): HarnessJournalSink {
    return (kind, data, eventKey) => {
      const written = this.#store.journal(operationId, kind, data, eventKey);
      if (!written || !op || op.closed) return;
      op.append({
        type: "extension",
        body: { type: "journal", record: written }
      });
    };
  }

  #eventSink(
    operationId: string,
    op: HarnessOperationHandle<SelfModifyingProtocol>,
    messageId: string,
    journal: HarnessJournalSink
  ): HarnessEventSink {
    return {
      emit: (eventKey, event) => {
        if (op.closed) return;
        // One claimed key is one frame: a replayed step re-emits, and the
        // log keeps the first projection only.
        if (this.#store.claimStreamEvent(operationId, eventKey)) {
          op.append(turnFrame(event));
        }
      },
      journal,
      preview: (delta) => {
        if (!op.closed) op.preview({ type: "text_delta", messageId, delta });
      }
    };
  }
}

/** A promise that resolves once `signal` aborts, and never rejects. */
function aborts(signal: AbortSignal): Promise<TurnOutcome> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ status: "aborted" });
      return;
    }
    signal.addEventListener("abort", () => resolve({ status: "aborted" }), {
      once: true
    });
  });
}
