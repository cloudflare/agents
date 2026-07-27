import type { UIMessage, UIMessageChunk } from "ai";

/** Who started a turn. Nothing may assume turns start with an inbound message. */
export type TurnOrigin = "inbound" | "agent";

/** How a settled turn ended. */
export type TurnOutcome = "ok" | "error" | "interrupted";

/**
 * Durable key/value state scoped to one conversation. Connectors use it to
 * remember facts that must survive restarts — session ids, stream offsets,
 * pending-submission records.
 */
export interface ConversationStateStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

/** One row of a turn's append-only output journal. */
export interface JournalEntry {
  seq: number;
  chunk: UIMessageChunk;
}

/**
 * The turn handed to a connector. The engine carries durable conversation
 * context but knows nothing about how output will eventually be delivered.
 */
export interface ConnectorTurn {
  /** Ledger id of this turn. Stable across recovery re-runs. */
  id: string;
  /** Stable host-defined scope for ordering and durable connector state. */
  conversationId: string;
  input: UIMessage[];
  origin: TurnOrigin;
  /**
   * Opaque, host-authored identity of whoever caused this turn. The
   * engine stamps and propagates it, never interprets it.
   */
  principal?: string;
  /**
   * Host-provided instructions for this conversation or source.
   */
  guidance?: string;
  /**
   * Interactions of this turn that a human has completed. On a re-entry
   * after a WAITING pause, the connector reads the answers here.
   */
  interactions: CompletedInteraction[];
  /** Aborted when the host cancels the turn. */
  signal: AbortSignal;
  state: ConversationStateStore;
}

/**
 * The contract between the turn engine and an agent runtime. A connector runs one
 * turn and streams AI SDK `UIMessageChunk`s back; the engine journals them.
 *
 * Connectors yield *content* chunks (text, reasoning, tool activity) — the
 * enclosing `start`/`finish` protocol frames belong to the consumers.
 */
export interface AgentConnector {
  run(turn: ConnectorTurn): AsyncIterable<UIMessageChunk>;
  capabilities?: {
    /**
     * The connector can continue a partially-journaled turn exactly (e.g.
     * from a durable stream offset). The engine — never the connector —
     * uses this to choose STREAMING-stage recovery: resume or interrupt.
     */
    resume?: boolean;
  };
}

/** An interaction a human has completed; injected into the turn's re-run. */
export interface CompletedInteraction {
  id: string;
  kind: string;
  payload?: unknown;
  value?: unknown;
}

/**
 * Thrown by a connector to pause its turn on a human interaction. The engine
 * records the interaction durably and parks the turn in WAITING; the
 * completion arrives later as an ordinary inbound event and re-enters the
 * connector. Connectors never wait in-memory for humans.
 */
export class TurnPause extends Error {
  readonly interaction: { id?: string; kind: string; payload?: unknown };

  constructor(interaction: { id?: string; kind: string; payload?: unknown }) {
    super(`The turn paused on a ${interaction.kind} interaction`);
    this.name = "TurnPause";
    this.interaction = interaction;
  }
}

export function isTurnPause(error: unknown): error is TurnPause {
  return (
    error instanceof TurnPause ||
    (error instanceof Error && error.name === "TurnPause")
  );
}

/**
 * Thrown by a connector when the turn was interrupted and its outcome will
 * be produced by a continuation elsewhere (or not at all). The engine
 * settles the turn as `interrupted` while retaining committed partial output.
 */
export class TurnInterruptedError extends Error {
  constructor(message = "The agent turn was interrupted") {
    super(message);
    this.name = "TurnInterruptedError";
  }
}

export function isTurnInterruptedError(error: unknown): boolean {
  return (
    error instanceof TurnInterruptedError ||
    (error instanceof Error && error.name === "TurnInterruptedError")
  );
}
