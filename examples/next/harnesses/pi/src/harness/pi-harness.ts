import type { Context } from "@earendil-works/chord";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal
} from "@earendil-works/chord/context";
import type { ModelThinkingLevel, Models } from "@earendil-works/pi-ai";
import {
  ConversationConfig,
  createRegistry,
  Harness,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  watchEvents,
  type AgentEventStream,
  type Conversation,
  type ConversationId,
  type ConversationRetryPolicy,
  type ModelRef,
  type Registry,
  type SettledSubmissionRecord,
  type ToolRegistration,
  type Tx,
  type UserInput
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import {
  LifecycleCapability,
  type CapabilityStartContext
} from "agents/lifecycle";
import type { SkillSource } from "agents/skills";
import type { WebSocketsOptions } from "agents/websockets";
import type {
  Driver,
  DriverError,
  DriverHandle,
  DriverOperation,
  DriverStep
} from "../driver";
import { assistantText, projectEntries } from "./messages";
import {
  openPiSessionStore,
  type PiSessionStoreOptions
} from "./session-store";
import { resolveSkillSources } from "./skills";
import { PiTransport } from "./transport";
import type {
  PiMessage,
  PiMessageInput,
  PiOperationResult,
  PiPendingOperation,
  PiPromptResponse,
  PiReceipt,
  PiSessionId,
  PiSessionInfo,
  PiSessionOptions,
  PiSubmitOptions,
  PiToolInfo,
  PiWhenBusy
} from "./types";

const BG = BACKGROUND_CONTEXT;

/** The root session's id, as the example addresses sessions. */
export const ROOT_SESSION: PiSessionId = String(ROOT_CONVERSATION_ID);

/**
 * A pi long wait further away than this becomes a driver `sleep`, so the
 * object's alarm, not an in-memory timer, is what wakes it.
 */
const SLEEP_THRESHOLD_MS = 60_000;

/**
 * Longest a step waits on pi. A step runs inside an alarm invocation, which
 * has a 15 minute wall-time limit, so a longer run is waited on across
 * several steps.
 */
const STEP_BUDGET_MS = 10 * 60_000;

export type PiHarnessOptions = {
  /** The host's driver. The harness registers one runtime on it. */
  readonly driver: Driver;
  /** Driver runtime id. Renaming it strands queued work. Default `"pi"`. */
  readonly id?: string;
  readonly models: Models;
  /** Model for new sessions. Change one session's with `session.setModel`. */
  readonly model: ModelRef;
  readonly thinkingLevel?: ModelThinkingLevel;
  /** pi's generation retries for new sessions. */
  readonly retry?: ConversationRetryPolicy;
  /** First system prompt section. */
  readonly systemPrompt?: string;
  readonly tools?: readonly ToolRegistration[];
  /** `agents/skills` sources, offered through `activate_skill`. */
  readonly skills?: readonly SkillSource[];
  /** Execution environment for pi's `read`/`bash`/`edit`/`write` tools. */
  readonly env?: ExecutionEnv;
  /** Add hooks, prompt sections, tasks, or more tools to pi's registry. */
  readonly configure?: (registry: Registry) => void;
  readonly store?: PiSessionStoreOptions;
  /** Extension failures pi reports without failing the operation. */
  readonly onReport?: (error: unknown) => void;
};

/** One driver operation: a pi input to admit and see through. */
type PiOperationInput = {
  readonly session: PiSessionId;
  readonly content: UserInput;
  readonly whenBusy: PiWhenBusy;
};

type Opened = {
  readonly pi: Harness;
  readonly storage: SqliteStorage;
};

function conversationId(session: PiSessionId): ConversationId {
  const id = Number(session);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error(`Invalid pi session ${JSON.stringify(session)}`);
  }
  return id as ConversationId;
}

function userInput(input: PiMessageInput): UserInput {
  if (typeof input === "string") return input;
  if (!input.images?.length) return input.text;
  return [
    { type: "text", text: input.text },
    ...input.images.map((image) => ({
      type: "image" as const,
      data: image.data,
      mimeType: image.mimeType
    }))
  ];
}

function signalContext(signal: AbortSignal | undefined): Context {
  return signal ? withAbortSignal(signal, BG) : BG;
}

/**
 * pi-durable hosted in a Durable Object, behind the harness interface the
 * other `examples/next/harnesses` share: `harness.prompt()`,
 * `harness.sessions`, `harness.session(id)`, `webSockets()`.
 *
 * pi owns everything about a run: the transcript, the inbox of steers and
 * follow-ups, generation and tool tasks, retries, crash recovery, and the
 * live view. It keeps all of it in its own tables in this object's SQLite
 * database (see `session-store.ts`).
 *
 * What pi cannot do on a Durable Object is wake itself: its scheduler runs
 * in memory, and an evicted object has no memory. The driver is that wake.
 * Each submission is one driver operation whose `step` re-admits the input
 * into pi by its request id (a no-op when pi already has it) and waits for
 * pi to settle it. The driver heartbeats the step through the object's
 * alarm, so an eviction mid-run fires the alarm, the object restarts, pi
 * reopens and resumes its own tasks, and the step waits again.
 *
 * @experimental Example-local. Nothing here is exported from `agents`.
 */
export class PiHarness extends LifecycleCapability {
  /** pi's registry. Registrations may change while the harness runs. */
  readonly registry: Registry;
  readonly sessions: PiSessions;
  readonly #options: PiHarnessOptions;
  readonly #driver: DriverHandle<PiOperationInput>;
  readonly #transport: PiTransport;
  #opening: Promise<Opened> | undefined;

  constructor(options: PiHarnessOptions) {
    super("pi-harness");
    this.#options = options;
    this.registry = createRegistry();
    this.registry.batch(() => {
      if (options.systemPrompt !== undefined) {
        const prompt = options.systemPrompt;
        this.registry.systemPrompt.section("preamble", () => prompt, {
          tag: false
        });
      }
      for (const tool of options.tools ?? []) this.registry.tools.add(tool);
      options.configure?.(this.registry);
    });
    this.sessions = new PiSessions(this);
    this.#transport = new PiTransport(this, () => this.lifecycle.sockets);
    this.#driver = options.driver.register<PiOperationInput, PiOperationResult>(
      options.id ?? "pi",
      {
        step: (operation, signal) => this.#step(operation, signal),
        stop: (operation) => this.#withdraw(operation)
      },
      {
        onFail: (operation, error) => this.#failed(operation, error),
        // pi's own retries cover the model. Driver retries are for the
        // harness failing to reach pi, such as a storage error on open.
        maxAttempts: 3
      }
    );
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  override async onStart(_context: CapabilityStartContext): Promise<void> {
    await this.#open();
    // Watches are in memory. Sockets that outlived the old isolate get a
    // fresh snapshot and a new watch.
    await this.#transport.reattach();
  }

  /** Close pi's in-memory resources. Durable state is untouched. */
  async dispose(): Promise<void> {
    await this.#transport.close();
    const opening = this.#opening;
    this.#opening = undefined;
    const opened = await opening?.catch(() => undefined);
    await opened?.pi.close(BG);
  }

  // ── The harness interface ────────────────────────────────────────────────

  /** A handle on one session. No I/O until you call it. */
  session(id: PiSessionId = ROOT_SESSION): PiSession {
    return new PiSession(this, id);
  }

  /** Submit a prompt and wait for its answer. */
  prompt(
    input: PiMessageInput,
    options: PiSubmitOptions = {}
  ): Promise<PiPromptResponse> {
    return this.session(options.session).prompt(input, options);
  }

  /** Durably submit a prompt. Resolves before the model runs. */
  submit(
    input: PiMessageInput,
    options: PiSubmitOptions = {}
  ): Promise<PiReceipt> {
    return this.session(options.session).submit(input, options);
  }

  /** Stop one operation, or everything running in a session. */
  abort(
    options: PiSessionOptions & { readonly operationId?: string } = {}
  ): Promise<boolean> {
    return this.session(options.session).abort(options.operationId);
  }

  wait(
    operationId: string,
    options: PiSessionOptions & { readonly signal?: AbortSignal } = {}
  ): Promise<PiOperationResult> {
    return this.session(options.session).wait(operationId, options.signal);
  }

  messages(options: PiSessionOptions = {}): Promise<PiMessage[]> {
    return this.session(options.session).messages();
  }

  /** Operations the driver still holds, oldest first. */
  async pending(options: PiSessionOptions = {}): Promise<PiPendingOperation[]> {
    const pending = await this.#driver.pending(options.session);
    return pending.map((operation) => ({
      operationId: operation.id,
      session: operation.scope,
      status: operation.status,
      submittedAt: operation.submittedAt
    }));
  }

  /** Tools registered now, as the UI lists them. */
  tools(): PiToolInfo[] {
    return this.registry.tools
      .list()
      .map((tool) => ({ name: tool.name, description: tool.description }));
  }

  /** Options for `new WebSockets(...)` serving the session protocol. */
  webSockets(): WebSocketsOptions {
    return this.#transport.options();
  }

  /** The opened pi Harness, for anything the interface does not cover. */
  async pi(): Promise<Harness> {
    return (await this.#open()).pi;
  }

  /** Resolve once no driver step is in flight. For tests. */
  waitForIdle(session?: PiSessionId): Promise<void> {
    return this.#driver.waitForIdle(session);
  }

  // ── Used by PiSession and PiSessions ─────────────────────────────────────

  /** @internal */
  async conversation(session: PiSessionId): Promise<Conversation> {
    const { pi } = await this.#open();
    const conversation = await pi.conversation(conversationId(session), BG);
    if (!conversation) throw new Error(`Unknown pi session ${session}`);
    return conversation;
  }

  /** @internal */
  async storage(): Promise<SqliteStorage> {
    return (await this.#open()).storage;
  }

  /** @internal Configure a new session like the root. */
  initSession(tx: Tx, id: ConversationId): Promise<void> {
    return this.#init(tx, id);
  }

  /** @internal */
  async enqueue(
    session: PiSessionId,
    input: PiMessageInput,
    options: PiSubmitOptions
  ): Promise<PiReceipt> {
    const operationId = options.operationId ?? crypto.randomUUID();
    const operation: PiOperationInput = {
      session,
      content: userInput(input),
      whenBusy: options.whenBusy ?? "followUp"
    };
    // The driver row first: it is what wakes the object if the admission
    // below is lost to an eviction.
    const receipt = await this.#driver.submit(session, operation, {
      id: operationId
    });
    // Then admit into pi now, not when the driver reaches this operation,
    // so pi's inbox places steers and follow-ups while a run is going. The
    // step admits again by the same request id, which pi deduplicates.
    await this.#admit(operationId, operation, BG);
    return { operationId, session, accepted: receipt.accepted };
  }

  /** @internal Stop one driver operation. */
  stopOperation(operationId: string): Promise<boolean> {
    return this.#driver.stop(operationId);
  }

  /** @internal Wait for pi to settle an operation, by its request id. */
  async settled(
    session: PiSessionId,
    operationId: string,
    signal?: AbortSignal
  ): Promise<PiOperationResult> {
    const conversation = await this.conversation(session);
    const context = signalContext(signal);
    const submission = await this.#findSubmission(
      conversation.id,
      operationId,
      context
    );
    if (!submission) {
      return {
        operationId,
        session,
        status: "unanswered",
        reason: "not_found"
      };
    }
    return this.#result(
      session,
      operationId,
      await submission.wait(context),
      context
    );
  }

  // ── Driver runtime ───────────────────────────────────────────────────────

  async #step(
    operation: DriverOperation<PiOperationInput>,
    signal: AbortSignal
  ): Promise<DriverStep<PiOperationResult>> {
    const { pi } = await this.#open();
    const context = signalContext(signal);
    const { session } = operation.input;
    const conversation = await pi.conversation(
      conversationId(session),
      context
    );
    if (!conversation) {
      return {
        then: "done",
        result: {
          operationId: operation.id,
          session,
          status: "unanswered",
          reason: "session_not_found"
        }
      };
    }
    const submission = await this.#admit(
      operation.id,
      operation.input,
      context
    );
    const wakeAt = await this.#longWait(pi, conversation.id, context);
    if (wakeAt !== undefined) return { then: "sleep", until: wakeAt };
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(), STEP_BUDGET_MS);
    let settled: SettledSubmissionRecord;
    try {
      // Cancelling the wait never cancels pi's work.
      settled = await submission.wait(withAbortSignal(budget.signal, context));
    } catch (error) {
      if (budget.signal.aborted && !signal.aborted) return { then: "continue" };
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return {
      then: "done",
      result: await this.#result(session, operation.id, settled, context)
    };
  }

  /** Withdraw a queued input, or abort the run it joined. */
  async #withdraw(operation: DriverOperation<PiOperationInput>): Promise<void> {
    const { pi, storage } = await this.#open();
    const id = conversationId(operation.input.session);
    const record = await storage.submissionByRequest(id, operation.id, BG);
    if (!record || record.status === "done" || record.status === "unanswered") {
      return;
    }
    const withdrawn = await pi.abortSubmission(record.id, BG, id);
    if (withdrawn === "already_placed") {
      await (await pi.conversation(id, BG))?.abort(BG);
    }
  }

  async #failed(
    operation: DriverOperation<PiOperationInput>,
    error: DriverError
  ): Promise<void> {
    this.lifecycle.events.emit("pi:operation_failed", {
      operationId: operation.id,
      session: operation.input.session,
      error: error.message
    });
    await this.#withdraw(operation);
  }

  // ── pi ───────────────────────────────────────────────────────────────────

  #open(): Promise<Opened> {
    this.#opening ??= this.#doOpen().catch((error: unknown) => {
      this.#opening = undefined;
      throw error;
    });
    return this.#opening;
  }

  async #doOpen(): Promise<Opened> {
    const skills = this.#options.skills;
    if (skills?.length) {
      const resolved = await resolveSkillSources(skills);
      for (const warning of resolved.warnings) {
        console.warn(`PiHarness skills: ${warning}`);
      }
      const catalog = resolved.catalog;
      this.registry.batch(() => {
        for (const tool of resolved.tools) this.registry.tools.add(tool);
        if (catalog)
          this.registry.systemPrompt.section("skills", () => catalog);
      });
    }
    const storage = await openPiSessionStore(
      this.lifecycle.storage,
      this.#options.store
    );
    const pi = await Harness.open(
      storage,
      {
        models: this.#options.models,
        registry: this.registry,
        ...(this.#options.env ? { env: this.#options.env } : {}),
        onReport:
          this.#options.onReport ??
          ((error) => console.warn("pi report", error))
      },
      BG
    );
    await pi.root(BG, { init: (tx, id) => this.#init(tx, id) });
    // Continue whatever the last isolate left: pi reconciles tasks that were
    // running to pending and schedules them again.
    pi.resume();
    return { pi, storage };
  }

  async #init(tx: Tx, id: ConversationId): Promise<void> {
    const config = await tx.doc(ConversationConfig, id);
    config.model = { ...this.#options.model };
    config.thinkingLevel = this.#options.thinkingLevel ?? "off";
    if (this.#options.retry) config.retry = { ...this.#options.retry };
  }

  #admit(operationId: string, input: PiOperationInput, context: Context) {
    return this.conversation(input.session).then((conversation) =>
      conversation.submit(
        {
          type: "input",
          content: input.content,
          whenBusy: input.whenBusy,
          requestId: operationId
        },
        context
      )
    );
  }

  async #findSubmission(
    id: ConversationId,
    operationId: string,
    context: Context
  ) {
    const { pi, storage } = await this.#open();
    // Read from pi's storage: the Harness only reacquires submissions by id.
    const record = await storage.submissionByRequest(id, operationId, context);
    return record ? pi.submission(record.id, context) : undefined;
  }

  /** When pi's current wait is far enough away to hand to the alarm. */
  async #longWait(
    pi: Harness,
    id: ConversationId,
    context: Context
  ): Promise<number | undefined> {
    const live = await pi.snapshot(LiveDoc, id, context);
    const at =
      live?.generation?.deferred?.pollAt ?? live?.generation?.retry?.at;
    return at !== undefined && at - Date.now() > SLEEP_THRESHOLD_MS
      ? at
      : undefined;
  }

  async #result(
    session: PiSessionId,
    operationId: string,
    settled: SettledSubmissionRecord,
    context: Context
  ): Promise<PiOperationResult> {
    if (settled.status === "unanswered") {
      return {
        operationId,
        session,
        status: "unanswered",
        reason: settled.reason
      };
    }
    if (settled.type !== "input")
      return { operationId, session, status: "done" };
    const conversation = await this.conversation(session);
    const page = await conversation.entries(
      { minEntryId: settled.answer, maxEntryId: settled.answer },
      1,
      undefined,
      context
    );
    return {
      operationId,
      session,
      status: "done",
      text: assistantText(page.items[0])
    };
  }
}

/** One pi conversation, addressed through the harness. */
export class PiSession {
  readonly #harness: PiHarness;
  readonly id: PiSessionId;

  constructor(harness: PiHarness, id: PiSessionId) {
    this.#harness = harness;
    this.id = id;
  }

  /** Durably submit a prompt. Resolves before the model runs. */
  submit(
    input: PiMessageInput,
    options: PiSubmitOptions = {}
  ): Promise<PiReceipt> {
    return this.#harness.enqueue(this.id, input, options);
  }

  /** Submit and wait for the answer and the updated transcript. */
  async prompt(
    input: PiMessageInput,
    options: PiSubmitOptions = {}
  ): Promise<PiPromptResponse> {
    const receipt = await this.submit(input, options);
    const result = await this.wait(receipt.operationId);
    return { ...result, messages: await this.messages() };
  }

  /** Join the running work after its current tool round. */
  steer(
    input: PiMessageInput,
    options: Omit<PiSubmitOptions, "whenBusy"> = {}
  ) {
    return this.submit(input, { ...options, whenBusy: "steer" });
  }

  /** Wait for an operation to settle. Aborting `signal` stops only the wait. */
  wait(operationId: string, signal?: AbortSignal): Promise<PiOperationResult> {
    return this.#harness.settled(this.id, operationId, signal);
  }

  /**
   * Stop one operation through the driver, or, with no id, abort the
   * session: pi withdraws queued inputs and aborts the running work.
   */
  async abort(operationId?: string): Promise<boolean> {
    if (operationId !== undefined) {
      return this.#harness.stopOperation(operationId);
    }
    const conversation = await this.#harness.conversation(this.id);
    await conversation.abort(BG);
    return true;
  }

  /** Start a new context, optionally from a handoff note. */
  async reset(handoff?: string): Promise<void> {
    await (await this.#harness.conversation(this.id)).reset(handoff, BG);
  }

  async setModel(model: ModelRef): Promise<void> {
    await (await this.#harness.conversation(this.id)).setModel(model, BG);
  }

  /** The active transcript: entries since the newest reset. */
  async messages(): Promise<PiMessage[]> {
    const view = await (await this.#harness.conversation(this.id)).context(BG);
    return projectEntries(view.entries);
  }

  /** pi's agent events for this session: a snapshot, then one batch per commit. */
  async events(context: Context = BG): Promise<AgentEventStream> {
    const pi = await this.#harness.pi();
    return watchEvents(pi, conversationId(this.id), context);
  }

  async busy(): Promise<boolean> {
    const pi = await this.#harness.pi();
    const live = await pi.snapshot(LiveDoc, conversationId(this.id), BG);
    return live?.run !== undefined;
  }
}

/** Every pi conversation in this object. */
export class PiSessions {
  readonly #harness: PiHarness;

  constructor(harness: PiHarness) {
    this.#harness = harness;
  }

  get(id: PiSessionId): PiSession {
    return this.#harness.session(id);
  }

  /** A new top-level session, configured like the root. */
  async create(): Promise<PiSession> {
    const pi = await this.#harness.pi();
    const conversation = await pi.createConversation(
      {
        ownership: { kind: "ownerless" },
        init: (tx, id) => this.#harness.initSession(tx, id)
      },
      BG
    );
    return this.#harness.session(String(conversation.id));
  }

  /** A new session that sees `from`'s history up to its newest entry. */
  async fork(from: PiSessionId): Promise<PiSession> {
    const conversation = await this.#harness.conversation(from);
    const newest = await conversation.entries({}, 1, undefined, BG);
    const at = newest.items[0];
    if (!at) throw new Error(`Session ${from} has no entries to fork from`);
    const fork = await conversation.fork(
      at.id,
      { ownership: { kind: "ownerless" } },
      BG
    );
    return this.#harness.session(String(fork.id));
  }

  /**
   * Every conversation, including ones subagent tools own. Read from pi's
   * storage directly: the Harness has no conversation listing.
   */
  async list(): Promise<PiSessionInfo[]> {
    const storage = await this.#harness.storage();
    const pi = await this.#harness.pi();
    const sessions: PiSessionInfo[] = [];
    let cursor: Parameters<SqliteStorage["scanConversations"]>[2];
    for (;;) {
      const page = await storage.scanConversations({}, 100, cursor, BG);
      for (const record of page.items) {
        const live = await pi.snapshot(LiveDoc, record.id, BG);
        sessions.push({
          id: String(record.id),
          ...(record.parent
            ? { parent: String(record.parent.conversationId) }
            : {}),
          busy: live?.run !== undefined
        });
      }
      if (page.next === undefined) return sessions;
      cursor = page.next;
    }
  }
}
