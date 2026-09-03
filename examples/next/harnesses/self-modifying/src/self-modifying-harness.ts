import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { Workspace } from "@cloudflare/shell";
import { LifecycleCapability } from "agents/lifecycle";
import type { Streams, StreamWriter } from "agents/streams";
import type { Tasks, TaskStep } from "agents/tasks";
import type { WebSocketsOptions } from "agents/websockets";
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
  HarnessSourceOperations
} from "./host-bridge";
import type { JsonObject, JsonValue } from "./json";
import type { HarnessTurnResult } from "./runtime-types";
import type { HarnessSnapshot, HarnessTurnReceipt } from "./protocol";
import { SEED_HARNESS_FILES } from "./seed";
import { SelfModifyingHarnessStore } from "./store";
import { HarnessTransport } from "./transport";
import type { HarnessBuild, HarnessRevision, HarnessTurn } from "./store";

const TURN_TASK = "__cf_self_modifying_turn_v1";

type TurnTaskInput = {
  turnId: string;
  streamId: string;
  revisionId: number;
  prompt: string;
};

type TurnTaskOutcome =
  | { ok: true; result: HarnessTurnResult }
  | { ok: false; error: string };

/** Snapshot consumed by the inspection UI. */
export type SelfModifyingHarnessSnapshot = HarnessSnapshot;

/** Receipt returned once a turn and its Tasks wake are durable. */
export type SelfModifyingTurnReceipt = HarnessTurnReceipt;

/** Configuration for the self-modifying Lifecycle capability. */
export type SelfModifyingHarnessOptions = {
  readonly tasks: Tasks;
  readonly streams: Streams;
  readonly workspace: Workspace;
  readonly loader: WorkerLoader;
  readonly model: LanguageModelV4;
};

/** Invalid task payload restored from durable storage. */
export class SelfModifyingTaskInputError extends Error {
  readonly _tag = "SelfModifyingTaskInputError" as const;
}

function turnTaskInput(value: unknown): TurnTaskInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SelfModifyingTaskInputError(
      "Harness turn task input must be an object"
    );
  }
  const record = value as Record<string, unknown>;
  const turnId = record.turnId;
  const streamId = record.streamId;
  const revisionId = record.revisionId;
  const prompt = record.prompt;
  if (
    typeof turnId !== "string" ||
    typeof streamId !== "string" ||
    typeof revisionId !== "number" ||
    !Number.isSafeInteger(revisionId) ||
    typeof prompt !== "string"
  ) {
    throw new SelfModifyingTaskInputError(
      "Harness turn task input fields are invalid"
    );
  }
  return { turnId, streamId, revisionId, prompt };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function textHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function buildErrorData(error: unknown): JsonObject {
  if (error instanceof HarnessBuildError) {
    return {
      tag: error._tag,
      phase: error.phase,
      message: error.message
    };
  }
  return { tag: "UnknownBuildError", message: errorMessage(error) };
}

function taskOutcome(value: TurnTaskOutcome): JsonValue {
  return value.ok
    ? {
        ok: true,
        result: {
          output: value.result.output,
          rounds: value.result.rounds,
          isolateRun: value.result.isolateRun,
          metadata: value.result.metadata ?? null
        }
      }
    : { ok: false, error: value.error };
}

/**
 * Trusted authority around a fully editable harness project.
 *
 * Each turn loads the pinned compiled revision into a fresh Dynamic Worker.
 * Editable code receives only a temporary {@link SelfModifyingTurnHost} RPC
 * target.
 */
export class SelfModifyingHarness extends LifecycleCapability {
  readonly #tasks: Tasks;
  readonly #streams: Streams;
  readonly #source: HarnessSource;
  readonly #loader: WorkerLoader;
  readonly #model: LanguageModelV4;
  #storeInstance: SelfModifyingHarnessStore | undefined;
  #sourceOperation: Promise<void> = Promise.resolve();
  #transport: HarnessTransport | undefined;

  /** Create the capability and register its durable turn driver. */
  constructor(options: SelfModifyingHarnessOptions) {
    super("self-modifying-harness");
    this.#tasks = options.tasks;
    this.#streams = options.streams;
    this.#source = new HarnessSource(options.workspace);
    this.#loader = options.loader;
    this.#model = options.model;
    this.#tasks.register(TURN_TASK, (input, step) =>
      this.#runTask(turnTaskInput(input), step)
    );
  }

  get #store(): SelfModifyingHarnessStore {
    this.#storeInstance ??= new SelfModifyingHarnessStore(
      this.lifecycle.storage
    );
    return this.#storeInstance;
  }

  /** Initialize trusted tables and compile the genesis source once. */
  async onStart(): Promise<void> {
    this.#store.ensureSchema();
    const active = this.#store.activeBuild();
    if (active) {
      await this.#withSourceLock(() => this.#source.seed(active.source));
      return;
    }

    const seeded = await this.#withSourceLock(() =>
      this.#source.seed(SEED_HARNESS_FILES)
    );
    if (!seeded) {
      this.#store.journal(null, "genesis_source_reused", {});
    }
    await this.#activate("genesis", "genesis");
  }

  /** Build and activate the current Workspace source. */
  async activate(
    note: string,
    activationKey?: string
  ): Promise<HarnessRevision> {
    await this.lifecycle.ready();
    return this.#activate(
      note,
      activationKey ?? `manual:${crypto.randomUUID()}`
    );
  }

  /** Restore an activated snapshot and record it as a new revision. */
  async restore(
    revisionId: number,
    activationKey?: string
  ): Promise<HarnessRevision> {
    await this.lifecycle.ready();
    const key = activationKey ?? `restore:${revisionId}:${crypto.randomUUID()}`;
    const replayed = this.#store.revisionByActivationKey(key);
    if (replayed) return replayed;
    const build = this.#store.build(revisionId);
    if (!build) throw new Error(`Harness revision ${revisionId} was not found`);
    return this.#withSourceLock(async () => {
      await this.#source.replace(build.source);
      this.#store.journal(null, "revision_source_restored", {
        fromRevisionId: revisionId
      });
      return this.#activateUnlocked(`restore revision ${revisionId}`, key);
    });
  }

  /** Write a working source file without changing the active revision. */
  async writeSource(path: string, content: string): Promise<void> {
    await this.lifecycle.ready();
    await this.#withSourceLock(async () => {
      await this.#source.write(path, content);
      this.#store.journal(null, "source_written", {
        path,
        bytes: new TextEncoder().encode(content).byteLength,
        source: "operator"
      });
    });
  }

  /** Admit a turn for queued execution and return its durable receipt. */
  async submit(
    prompt: string,
    turnId: string = crypto.randomUUID()
  ): Promise<SelfModifyingTurnReceipt> {
    await this.lifecycle.ready();
    return this.#admit(prompt, turnId, "queued");
  }

  /** Admit and run a turn in the current invocation, then return its state. */
  async prompt(
    prompt: string,
    turnId: string = crypto.randomUUID()
  ): Promise<HarnessTurn> {
    await this.lifecycle.ready();
    const receipt = await this.#admit(prompt, turnId, "attached");
    const turn = this.#store.turn(receipt.turnId);
    if (!turn) throw new Error(`Turn ${receipt.turnId} disappeared`);
    return turn;
  }

  /** Read one admitted turn. */
  async getTurn(turnId: string): Promise<HarnessTurn | null> {
    await this.lifecycle.ready();
    return this.#store.turn(turnId);
  }

  /** Return the active source, revisions, turns, and journal for the UI. */
  async snapshot(): Promise<SelfModifyingHarnessSnapshot> {
    await this.lifecycle.ready();
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
          size: new TextEncoder().encode(content).byteLength,
          content
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
      revisions: this.#store.revisions(),
      turns: this.#store.turns().reverse(),
      journal: this.#store.journalTail()
    };
  }

  /**
   * Options for a `WebSockets` capability serving this harness's protocol:
   * `new WebSockets(this.harness.webSockets())`.
   */
  webSockets(): WebSocketsOptions {
    this.#transport ??= new HarnessTransport(
      {
        streams: this.#streams,
        snapshot: () => this.snapshot(),
        submit: (prompt) => this.submit(prompt),
        getTurn: (turnId) => this.getTurn(turnId),
        writeSource: (path, content) => this.writeSource(path, content),
        activate: (note) => this.activate(note),
        restore: (revisionId) => this.restore(revisionId)
      },
      () => this.lifecycle.sockets
    );
    return this.#transport.webSocketOptions();
  }

  #turnChanged(turnId: string): void {
    const turn = this.#store.turn(turnId);
    if (turn) this.#transport?.turnChanged(turn);
  }

  async #activate(
    note: string,
    activationKey: string
  ): Promise<HarnessRevision> {
    return this.#withSourceLock(() =>
      this.#activateUnlocked(note, activationKey)
    );
  }

  async #activateUnlocked(
    note: string,
    activationKey: string
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
      this.#store.journal(
        null,
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
      this.#store.journal(
        null,
        "harness_activation_failed",
        buildErrorData(error)
      );
      throw error;
    }
  }

  async #admit(
    prompt: string,
    turnId: string,
    mode: "attached" | "queued"
  ): Promise<SelfModifyingTurnReceipt> {
    if (prompt.trim() === "") throw new Error("Turn prompt must not be empty");
    const active = this.#store.activeBuild();
    if (!active) throw new Error("Harness genesis has not been activated");
    const existing = this.#store.turn(turnId);
    const promptHash = await textHash(prompt);
    const existingTask = await this.#tasks.getByIdempotencyKey(
      `self-modifying-turn:${turnId}`
    );
    const taskPromptHash = existingTask?.metadata?.promptHash;
    if (
      (existing && existing.prompt !== prompt) ||
      (typeof taskPromptHash === "string" && taskPromptHash !== promptHash)
    ) {
      throw new Error(`Turn ${turnId} already exists with different input`);
    }
    const taskRevisionId = existingTask?.metadata?.revisionId;
    const taskStreamId = existingTask?.metadata?.streamId;
    const revisionId =
      existing?.revisionId ??
      (typeof taskRevisionId === "number" ? taskRevisionId : active.revisionId);
    const streamId =
      existing?.streamId ??
      (typeof taskStreamId === "string"
        ? taskStreamId
        : `self-modifying:${turnId}`);
    const input: TurnTaskInput = {
      turnId,
      streamId,
      revisionId,
      prompt
    };
    const taskOptions = {
      idempotencyKey: `self-modifying-turn:${turnId}`,
      metadata: { revisionId, streamId, promptHash }
    };
    const receipt =
      mode === "attached"
        ? await this.#tasks.__DO_NOT_USE_WILL_BREAK__runAttached(
            TURN_TASK,
            input,
            taskOptions
          )
        : await this.#tasks.__DO_NOT_USE_WILL_BREAK__enqueue(
            TURN_TASK,
            input,
            taskOptions
          );
    if (!this.#store.turn(turnId)) {
      this.#store.beginTurn(input);
      await this.#streams.open(streamId, {
        tag: "self-modifying-turn",
        metadata: { turnId, revisionId }
      });
      this.#turnChanged(turnId);
    }
    return {
      turnId,
      streamId,
      revisionId,
      accepted: receipt.accepted
    };
  }

  #withSourceLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#sourceOperation.then(operation, operation);
    this.#sourceOperation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async #runTask(input: TurnTaskInput, step: TaskStep): Promise<JsonValue> {
    this.#store.beginTurn(input);
    const previous = this.#store.turn(input.turnId);
    if (previous?.state === "completed" && previous.output !== null) {
      const status = await this.#streams.status(input.streamId);
      if (status?.state === "streaming") {
        const writer = await this.#streams.open(input.streamId);
        this.#emit(writer, input.turnId, "turn:finish", {
          type: "turn_completed",
          output: previous.output,
          rounds: previous.rounds ?? 0,
          isolateRun: previous.isolateRun ?? 0
        });
        writer.close();
      }
      return taskOutcome({
        ok: true,
        result: {
          output: previous.output,
          rounds: previous.rounds ?? 0,
          isolateRun: previous.isolateRun ?? 0
        }
      });
    }
    if (previous?.state === "failed" && previous.error !== null) {
      const status = await this.#streams.status(input.streamId);
      if (status?.state === "streaming") {
        const writer = await this.#streams.open(input.streamId);
        this.#emit(writer, input.turnId, "turn:failure", {
          type: "turn_failed",
          error: previous.error
        });
        writer.error(previous.error);
      }
      return taskOutcome({ ok: false, error: previous.error });
    }

    const writer = await this.#streams.open(input.streamId, {
      tag: "self-modifying-turn",
      metadata: { turnId: input.turnId, revisionId: input.revisionId }
    });
    this.#store.markRunning(input.turnId);
    this.#turnChanged(input.turnId);
    this.#emit(writer, input.turnId, "turn:start", {
      type: "turn_started",
      turnId: input.turnId,
      revisionId: input.revisionId
    });

    let outcome: JsonValue;
    try {
      outcome = await step.do(
        "run-editable-harness",
        { timeout: "5 minutes", retries: { limit: 2, delay: "5 seconds" } },
        async () =>
          taskOutcome({
            ok: true,
            result: await this.#runPinnedTurn(input, writer)
          })
      );
    } catch (error) {
      outcome = taskOutcome({ ok: false, error: errorMessage(error) });
    }

    const parsed = this.#parseOutcome(outcome);
    if (parsed.ok) {
      this.#store.completeTurn(input.turnId, parsed.result);
      this.#emit(writer, input.turnId, "turn:finish", {
        type: "turn_completed",
        output: parsed.result.output,
        rounds: parsed.result.rounds,
        isolateRun: parsed.result.isolateRun
      });
      writer.close();
    } else {
      this.#store.failTurn(input.turnId, parsed.error);
      this.#emit(writer, input.turnId, "turn:failure", {
        type: "turn_failed",
        error: parsed.error
      });
      writer.error(parsed.error);
    }
    this.#turnChanged(input.turnId);
    // A turn may have activated a revision; refresh connected inspectors.
    await this.#transport?.stateChanged();
    return outcome;
  }

  async #runPinnedTurn(
    input: TurnTaskInput,
    writer: StreamWriter
  ): Promise<HarnessTurnResult> {
    const build = this.#requireBuild(input.revisionId);
    const events: HarnessEventSink = {
      emit: (eventKey, event) =>
        this.#emit(writer, input.turnId, eventKey, event)
    };
    const activation: HarnessActivation = {
      activate: (note, key) => this.#activate(note, key),
      restore: async (revisionId, key) => {
        const replayed = this.#store.revisionByActivationKey(key);
        if (replayed) return replayed;
        const restored = this.#store.build(revisionId);
        if (!restored) {
          throw new Error(`Harness revision ${revisionId} was not found`);
        }
        return this.#withSourceLock(async () => {
          await this.#source.replace(restored.source);
          return this.#activateUnlocked(`restore revision ${revisionId}`, key);
        });
      }
    };
    const source: HarnessSourceOperations = {
      read: (path) => this.#withSourceLock(() => this.#source.read(path)),
      write: (path, content) =>
        this.#withSourceLock(() => this.#source.write(path, content)),
      delete: (path) => this.#withSourceLock(() => this.#source.delete(path)),
      list: () => this.#withSourceLock(() => this.#source.list())
    };
    const host = new SelfModifyingTurnHost({
      turnId: input.turnId,
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
          turnId: input.turnId,
          prompt: input.prompt,
          revisionId: input.revisionId,
          history: this.#store.historyBefore(input.turnId)
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
    if (!build)
      throw new Error(`Pinned harness revision ${revisionId} was not found`);
    return build;
  }

  #emit(
    writer: StreamWriter,
    turnId: string,
    eventKey: string,
    event: JsonObject
  ): void {
    this.lifecycle.storage.transactionSync(() => {
      if (this.#store.claimStreamEvent(turnId, eventKey)) writer.append(event);
    });
  }

  #parseOutcome(value: JsonValue): TurnTaskOutcome {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new SelfModifyingTaskInputError(
        "Stored harness turn outcome must be an object"
      );
    }
    if (value.ok === false && typeof value.error === "string") {
      return { ok: false, error: value.error };
    }
    const result = value.result;
    if (
      value.ok !== true ||
      typeof result !== "object" ||
      result === null ||
      Array.isArray(result) ||
      typeof result.output !== "string" ||
      typeof result.rounds !== "number" ||
      typeof result.isolateRun !== "number"
    ) {
      throw new SelfModifyingTaskInputError(
        "Stored harness turn success result is invalid"
      );
    }
    return {
      ok: true,
      result: {
        output: result.output,
        rounds: result.rounds,
        isolateRun: result.isolateRun,
        ...(typeof result.metadata === "object" && result.metadata !== null
          ? { metadata: result.metadata as JsonObject }
          : {})
      }
    };
  }
}
