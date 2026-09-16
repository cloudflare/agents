/**
 * The engine port. An engine is whatever actually runs the agent loop inside
 * the container: the Claude Agent SDK, or the echo fixture. It knows nothing
 * about Cap'n Web, the outbox or the Durable Object; it emits frames and
 * parks on requests, and the daemon makes those durable.
 *
 * The seam is deliberately the same shape as the shared `HarnessRuntime`:
 * inputs arrive as inbox rows, work is bracketed by a `begin` and a `settle`
 * control frame, and a question to the human is a durable request rather
 * than a live promise.
 */
import type {
  HarnessCapability,
  HarnessEventBody,
  HarnessInput,
  HarnessPreviewBody,
  HarnessReply,
  HarnessRequestDraft,
  JsonValue
} from "../../../shared/src/types.ts";
import type { HarnessWireControl } from "../../../shared/src/protocol.ts";

/** Everything an engine may do to the outside world. */
export type EngineContext = {
  /**
   * Append one frame. `operationId` is null for a frame that belongs to the
   * session rather than to a turn.
   */
  emit(
    operationId: string | null,
    body: HarnessEventBody | HarnessWireControl
  ): void;
  /** A token delta. Live only: never stored, dropped when nobody is subscribed. */
  preview(operationId: string | null, body: HarnessPreviewBody): void;
  /**
   * Open a durable request and park until an answer is delivered. Idempotent
   * per `requestId`: a second open with the same id joins the first park.
   * Rejects only when the daemon is shutting down.
   */
  openRequest(draft: HarnessRequestDraft): Promise<HarnessReply>;
  log(...args: readonly unknown[]): void;
};

/** A patch the Durable Object pushes with `configure()`. */
export type EngineConfigure = {
  readonly remainingBudgetUsd?: number | null;
  readonly engineOptions?: unknown;
  /**
   * The engine's own transcript, replayed chunk by chunk before the first
   * turn on this container. Mirrors `HarnessConfigureRequest.engineLog`: an
   * engine that keeps no transcript of its own ignores it.
   */
  readonly engineLog?: readonly {
    readonly engineSessionId: string;
    /** A subagent transcript or sidecar, else null for the main transcript. */
    readonly subpath: string | null;
    readonly entries: readonly JsonValue[];
    readonly chunk: number;
    readonly chunks: number;
  }[];
  /** The engine session the first turn must resume, once `engineLog` is complete. */
  readonly resume?: { readonly engineSessionId: string };
};

export interface Engine {
  /** Selects the engine inside the image: `"claude-code"`, `"echo"`. */
  readonly id: string;
  readonly version: string;
  readonly capabilities: readonly HarnessCapability[];
  /** The engine's own session, once it has one. Reported on `hello()`. */
  readonly engineSession: {
    readonly id: string;
    readonly resumed: boolean;
  } | null;
  /** The operation the engine is executing right now, if any. */
  readonly activeOperationId: string | null;

  /** Called once, before the first delivery. Must not block on the model. */
  start(ctx: EngineContext): Promise<void>;
  /** Admit one turn. Returns as soon as the turn is queued or started. */
  prompt(
    operationId: string,
    input: HarnessInput,
    delivery: "queue" | "steer"
  ): Promise<void>;
  /** Ask the running turn to stop. A no-op when it is not running. */
  interrupt(operationId: string): Promise<void>;
  /** Optional: react to an answer. The daemon settles the parked request itself. */
  reply?(
    requestId: string,
    reply: HarnessReply,
    by: "client" | "timeout" | "lost"
  ): Promise<void>;
  compact?(
    operationId: string,
    options: { readonly instructions?: string }
  ): Promise<void>;
  /** A runtime-specific inbox kind. Throws to make the daemon answer `E_PROTOCOL`. */
  submit?(
    kind: string,
    payload: unknown,
    operationId: string | null
  ): Promise<void>;
  configure?(patch: EngineConfigure): Promise<void>;
  shutdown(): Promise<void>;
  /** Optional: engine-owned counters and state, reported on `probe()`. */
  diagnostics?(): JsonValue;
}

/** How a parked request was answered. */
export type RequestOutcome = {
  readonly reply: HarnessReply;
  readonly by: "client" | "timeout" | "lost";
};

type Parked = {
  readonly draft: HarnessRequestDraft;
  readonly waiters: ((outcome: RequestOutcome) => void)[];
  expiresAt: number;
};

/**
 * The parked-request table. A request lives here while the engine waits and
 * in the outbox while anyone else might care; the daemon owns both sides so
 * an engine never has to think about redelivery or deadlines.
 *
 * Deadlines are owned twice on purpose. The Durable Object writes a timeout
 * reply into the inbox, and this timer auto-denies if that never arrives, so
 * a permission cannot wedge a turn for ever.
 */
export class RequestRegistry {
  readonly #parked = new Map<string, Parked>();
  readonly #onOpen: (draft: HarnessRequestDraft, expiresAt: number) => void;
  readonly #onClose: (
    requestId: string,
    by: "answered" | "timeout" | "lost",
    reply?: HarnessReply
  ) => void;
  readonly #defaultTimeoutMs: number;

  constructor(options: {
    readonly onOpen: (draft: HarnessRequestDraft, expiresAt: number) => void;
    readonly onClose: (
      requestId: string,
      by: "answered" | "timeout" | "lost",
      reply?: HarnessReply
    ) => void;
    readonly defaultTimeoutMs?: number;
  }) {
    this.#onOpen = options.onOpen;
    this.#onClose = options.onClose;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 600_000;
  }

  get size(): number {
    return this.#parked.size;
  }

  openIds(): readonly string[] {
    return [...this.#parked.keys()];
  }

  /** Open or join a request and resolve when it is answered, denied or lost. */
  open(draft: HarnessRequestDraft): Promise<HarnessReply> {
    const existing = this.#parked.get(draft.requestId);
    if (existing) {
      return new Promise((resolve) => {
        existing.waiters.push((outcome) => resolve(outcome.reply));
      });
    }
    const expiresAt = draft.expiresAt ?? Date.now() + this.#defaultTimeoutMs;
    const parked: Parked = { draft, waiters: [], expiresAt };
    this.#parked.set(draft.requestId, parked);
    this.#onOpen(draft, expiresAt);
    return new Promise((resolve) => {
      parked.waiters.push((outcome) => resolve(outcome.reply));
    });
  }

  /** Answer one request. False when nothing was parked under that id. */
  settle(
    requestId: string,
    reply: HarnessReply,
    by: "client" | "timeout" | "lost"
  ): boolean {
    const parked = this.#parked.get(requestId);
    if (!parked) return false;
    this.#parked.delete(requestId);
    this.#onClose(
      requestId,
      by === "client" ? "answered" : by,
      by === "client" ? reply : undefined
    );
    for (const waiter of parked.waiters) waiter({ reply, by });
    return true;
  }

  setDeadline(requestId: string, expiresAt: number): void {
    const parked = this.#parked.get(requestId);
    if (parked) parked.expiresAt = expiresAt;
  }

  /**
   * Auto-deny everything past its deadline. Called on a timer, so a request
   * the Durable Object never came back for still ends.
   */
  sweep(now: number): void {
    for (const [requestId, parked] of [...this.#parked]) {
      if (parked.expiresAt > now) continue;
      this.settle(
        requestId,
        {
          type: "permission",
          decision: "deny",
          message: "Timed out waiting for an answer"
        },
        "timeout"
      );
    }
  }

  /** Fail everything still parked. Used at shutdown. */
  drain(message: string): void {
    for (const requestId of [...this.#parked.keys()]) {
      this.settle(
        requestId,
        { type: "permission", decision: "deny", message },
        "lost"
      );
    }
  }
}

/** The plain text of a harness input, whatever shape it arrived in. */
export function inputText(input: HarnessInput): string {
  if (typeof input === "string") return input;
  if (input.text !== undefined) return input.text;
  return (input.parts ?? [])
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("");
}
