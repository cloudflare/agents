import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AgentLane,
  Context,
  Entry,
  ThinkingLevel
} from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ContextUsage } from "../../../vendor/pi-coding-agent-src/core/extensions/types.ts";

/** One failure raised by a hook, an event handler, or an extension itself. */
export type PiExtensionHandlerError = {
  readonly lane: string;
  readonly kind: "hook" | "event" | "extension";
  /** Hook name, event type, or extension path the failure came from. */
  readonly source: string;
  readonly message: string;
  readonly stack?: string;
};

/** Reports one handler failure onto the lane's event stream. */
export type PiExtensionErrorReporter = (error: PiExtensionHandlerError) => void;

/**
 * The read model one lane's extension actions see.
 *
 * Pi's extension API is synchronous while every lane read is asynchronous, so
 * the runtime keeps a cached view per lane and refreshes it before each hook
 * or event handler runs. Writes go the other way: they are appended to a
 * per-lane promise chain so extension calls keep their issue order and a
 * failure surfaces as a `handler_error` instead of an unhandled rejection.
 */
export class ExtensionLaneState {
  readonly lane: string;
  /** Operation currently driving this lane, when a run is in flight. */
  runId: string | undefined;
  entries: readonly Entry[] = [];
  tipId: string | null = null;
  activeTools: readonly string[] = [];
  thinkingLevel: ThinkingLevel = "off";
  model: Model<Api> | undefined;
  sessionName: string | undefined;
  busy = false;
  /**
   * Messages waiting to run on this lane: pi's own admitted queue plus the
   * harness's intake rows, which are submissions the lane driver has not
   * handed to pi yet. An extension asking whether anything is pending has to
   * see both, or a prompt submitted while a run holds the lane reads as
   * absent.
   */
  queued = 0;
  contextUsage: ContextUsage | undefined;
  /** System prompt of the current provider request, as pi assembled it. */
  systemPrompt = "";
  /** Replacement an extension asked for in `before_agent_start`. */
  systemPromptOverride: string | undefined;

  #chain: Promise<void> = Promise.resolve();

  constructor(lane: string) {
    this.lane = lane;
  }

  /** Queue one lane write behind this lane's earlier extension writes. */
  enqueue(
    source: string,
    resolveLane: (lane: string) => Promise<AgentLane>,
    report: PiExtensionErrorReporter,
    work: (lane: AgentLane, context: Context) => Promise<void>
  ): void {
    this.#chain = this.#chain.then(async () => {
      try {
        const lane = await resolveLane(this.lane);
        await work(lane, BACKGROUND_CONTEXT);
      } catch (error) {
        report({
          lane: this.lane,
          kind: "extension",
          source,
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.stack !== undefined
            ? { stack: error.stack }
            : {})
        });
      }
    });
  }

  /** Wait for this lane's queued extension writes to drain. */
  async drain(): Promise<void> {
    await this.#chain;
  }

  /**
   * Re-read the lane so the synchronous extension API sees current values.
   *
   * `pendingSubmissions` is the harness's own intake count for this lane;
   * pi's snapshot knows nothing about it.
   */
  async refresh(
    lane: AgentLane,
    context: Context,
    pendingSubmissions = 0
  ): Promise<void> {
    const handle = await lane.watch(context);
    handle.unsubscribe();
    const snapshot = handle.snapshot;
    this.entries = snapshot.transcript;
    this.tipId = snapshot.tipId;
    this.activeTools = snapshot.configuration.activeToolNames;
    this.thinkingLevel = snapshot.configuration.thinkingLevel;
    this.busy = snapshot.operation !== null;
    this.queued = snapshot.queues.length + pendingSubmissions;
    this.model = await lane.getModel(context);
    this.contextUsage = {
      tokens: null,
      contextWindow: this.model?.contextWindow ?? 0,
      percent: null
    };
  }
}

/**
 * One `withLane` scope: the lane it runs on, and the cancellation of the
 * work that opened it.
 *
 * The signal belongs to the scope rather than to the lane, because it is the
 * hook invocation's, the tool call's or the operation's — a lane outlives all
 * three, and a handler that read a lane-shaped signal would be watching
 * something that never aborts.
 */
type ExtensionLaneScope = {
  readonly state: ExtensionLaneState;
  readonly signal: AbortSignal | undefined;
};

/** What a `withLane` scope carries besides the lane itself. */
export type ExtensionLaneScopeOptions = {
  /** Operation driving the lane, when the scope belongs to a run. */
  readonly runId?: string;
  /** Cancellation of the work the scope was opened for. */
  readonly signal?: AbortSignal;
};

/** Every lane the extension runtime has observed, keyed by lane name. */
export class ExtensionLaneStates {
  readonly #states = new Map<string, ExtensionLaneState>();
  readonly #defaultLane: string;
  /**
   * The lane of the hook, event, command or tool call currently running.
   *
   * It is async-context state, not a variable: two lanes make progress
   * concurrently, and each one awaits — a UI dialog, a lane read, a tool
   * body. A saved-and-restored field would hand lane A's continuation
   * whatever lane B entered while A was suspended, so the current lane
   * travels with the async context that established it instead.
   */
  readonly #currentLane = new AsyncLocalStorage<ExtensionLaneScope>();
  /** Lane for synchronous `pi.*` calls made outside any `withLane` scope. */
  #fallback: string;

  constructor(defaultLane: string) {
    this.#defaultLane = defaultLane;
    this.#fallback = defaultLane;
  }

  /**
   * Pi's `ExtensionContext` names no lane, so actions resolve against the
   * lane whose hook or event is running, and against the default lane when
   * nothing is.
   */
  get current(): ExtensionLaneState {
    return this.#currentLane.getStore()?.state ?? this.get(this.#fallback);
  }

  /**
   * Cancellation of the work whose scope is running, for `ctx.signal`.
   *
   * Undefined outside a scope, and outside one opened for cancellable work:
   * an extension that is told nothing aborts is better served than one handed
   * a signal that never fires.
   */
  get currentSignal(): AbortSignal | undefined {
    return this.#currentLane.getStore()?.signal;
  }

  get defaultLane(): string {
    return this.#defaultLane;
  }

  get(lane: string): ExtensionLaneState {
    let state = this.#states.get(lane);
    if (!state) {
      state = new ExtensionLaneState(lane);
      this.#states.set(lane, state);
    }
    return state;
  }

  /**
   * Make one lane the fallback target of synchronous extension calls made
   * outside a `withLane` scope.
   *
   * Only legacy call sites need this: everything the runtime drives — hooks,
   * notifications, commands, input handlers and extension tools — runs
   * inside `withLane`, whose scope always wins over this.
   */
  enter(lane: string, runId?: string): ExtensionLaneState {
    this.#fallback = lane;
    const state = this.get(lane);
    if (runId !== undefined) state.runId = runId;
    return state;
  }

  /**
   * Run `work` with `lane` as the current lane for everything it awaits.
   *
   * Pi's `ExtensionContext` names no lane, so a handler's synchronous
   * `pi.*` calls resolve against whichever lane is current. The scope is an
   * `AsyncLocalStorage` run rather than a saved-and-restored field, because
   * the callers are genuinely concurrent: a hook on one lane can suspend on
   * a blocking UI dialog while a notification on another lane runs to
   * completion, and the suspended hook has to resume on its own lane.
   */
  async withLane<T>(
    lane: string,
    work: (state: ExtensionLaneState) => Promise<T>,
    options: ExtensionLaneScopeOptions = {}
  ): Promise<T> {
    const state = this.get(lane);
    if (options.runId !== undefined) state.runId = options.runId;
    const scope: ExtensionLaneScope = { state, signal: options.signal };
    return this.#currentLane.run(scope, () => work(state));
  }

  all(): readonly ExtensionLaneState[] {
    return [...this.#states.values()];
  }
}
