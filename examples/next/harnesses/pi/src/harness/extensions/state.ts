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
  queued = 0;
  contextUsage: ContextUsage | undefined;
  /** System prompt of the current provider request, as pi assembled it. */
  systemPrompt = "";
  /** Replacement an extension asked for in `before_agent_start`. */
  systemPromptOverride: string | undefined;
  /** Cancellation of the work currently running on this lane. */
  signal: AbortSignal | undefined;

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

  /** Re-read the lane so the synchronous extension API sees current values. */
  async refresh(lane: AgentLane, context: Context): Promise<void> {
    const handle = await lane.watch(context);
    handle.unsubscribe();
    const snapshot = handle.snapshot;
    this.entries = snapshot.transcript;
    this.tipId = snapshot.tipId;
    this.activeTools = snapshot.configuration.activeToolNames;
    this.thinkingLevel = snapshot.configuration.thinkingLevel;
    this.busy = snapshot.operation !== null;
    this.queued = snapshot.queues.length;
    this.model = await lane.getModel(context);
    this.contextUsage = {
      tokens: null,
      contextWindow: this.model?.contextWindow ?? 0,
      percent: null
    };
  }
}

/** Every lane the extension runtime has observed, keyed by lane name. */
export class ExtensionLaneStates {
  readonly #states = new Map<string, ExtensionLaneState>();
  readonly #defaultLane: string;
  #current: string;

  constructor(defaultLane: string) {
    this.#defaultLane = defaultLane;
    this.#current = defaultLane;
  }

  /**
   * Pi's `ExtensionContext` names no lane, so actions resolve against the
   * lane whose hook or event is running, and against the default lane when
   * nothing is.
   */
  get current(): ExtensionLaneState {
    return this.get(this.#current);
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

  /** Make one lane the target of subsequent synchronous extension calls. */
  enter(lane: string, runId?: string): ExtensionLaneState {
    this.#current = lane;
    const state = this.get(lane);
    if (runId !== undefined) state.runId = runId;
    return state;
  }

  /**
   * Run one serialized chain step with `lane` as the current lane, and put
   * the previous lane back afterwards.
   *
   * Pi's `ExtensionContext` names no lane, so a handler's synchronous
   * `pi.*` calls resolve against whichever lane is current. Without the
   * restore, a hook or notification on a second lane would leave that lane
   * current for everything that followed it, and a handler on the quiet lane
   * would write to the busy one. The callers are each other's only
   * contenders and both serialize their work, so a save/restore around the
   * awaited step is enough; nothing here makes concurrent chains safe.
   */
  async withLane<T>(
    lane: string,
    work: (state: ExtensionLaneState) => Promise<T>,
    runId?: string
  ): Promise<T> {
    const previous = this.#current;
    const state = this.enter(lane, runId);
    try {
      return await work(state);
    } finally {
      this.#current = previous;
    }
  }

  all(): readonly ExtensionLaneState[] {
    return [...this.#states.values()];
  }
}
