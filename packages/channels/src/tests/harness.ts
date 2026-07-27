import type { UIMessageChunk } from "ai";
import { DurableTurnEngine, type RecoveryResolution } from "../engine/engine";
import type { TurnEngineHost } from "../engine/host";
import { SqliteTurnStore, type TurnRecord } from "../storage/store";
import type { AgentConnector, ConnectorTurn, JournalEntry } from "../types";

/**
 * Chaos-suite harness: engines over real DO SQLite, scripted connectors
 * that park at exact crash points, and a controllable clock. "Killing" the
 * engine = abandoning one instance mid-run and constructing a fresh one
 * over the same storage — from the new engine's perspective that is
 * indistinguishable from a process death, because the dead run's durable
 * writes simply stop.
 */

/** A point a scripted connector parks at until the test releases it. */
export class Gate {
  readonly passed: Promise<void>;
  private release!: () => void;

  constructor() {
    this.passed = new Promise((resolve) => {
      this.release = resolve;
    });
  }

  open(): void {
    this.release();
  }
}

export class FakeClock {
  constructor(private value = 1_700_000_000_000) {}

  now(): number {
    return this.value;
  }

  advance(ms: number): void {
    this.value += ms;
  }
}

export interface TestEngine {
  engine: DurableTurnEngine;
  host: TurnEngineHost;
  store: SqliteTurnStore;
  /** Every `wake(at)` the engine requested, in order. */
  wakes: number[];
  /** Every recovery resolution the engine reported, in order. */
  recovered: Array<{ turn: TurnRecord; resolution: RecoveryResolution }>;
}

export function makeEngine(options: {
  storage: DurableObjectStorage;
  connector: AgentConnector;
  clock?: FakeClock;
}): TestEngine {
  const store = new SqliteTurnStore(options.storage);
  const clock = options.clock ?? new FakeClock();
  const wakes: number[] = [];
  const recovered: TestEngine["recovered"] = [];
  const host: TurnEngineHost = {
    holdWhile: (work) => work,
    now: () => clock.now(),
    storage: store,
    wake: (at) => {
      wakes.push(at);
    }
  };
  const engine = new DurableTurnEngine({
    connector: options.connector,
    host,
    onRecovered: (turn, resolution) => {
      recovered.push({ resolution, turn });
    }
  });
  return { engine, host, recovered, store, wakes };
}

/**
 * A connector whose behavior differs per run attempt, so tests can park
 * the first run at a crash point and script the recovery run.
 */
export function attemptConnector(
  attempts: Array<(turn: ConnectorTurn) => AsyncIterable<UIMessageChunk>>,
  capabilities?: AgentConnector["capabilities"]
): AgentConnector & { runs: ConnectorTurn[] } {
  const runs: ConnectorTurn[] = [];
  return {
    capabilities,
    runs,
    run(turn: ConnectorTurn): AsyncIterable<UIMessageChunk> {
      runs.push(turn);
      // The last scripted attempt repeats for any further runs.
      const attempt = attempts[Math.min(runs.length, attempts.length) - 1];
      if (!attempt) {
        throw new Error("attemptConnector: no attempt scripted");
      }
      return attempt(turn);
    }
  };
}

/** Stream one complete text part. */
export async function* textPart(
  id: string,
  ...deltas: string[]
): AsyncGenerator<UIMessageChunk> {
  yield { id, type: "text-start" };
  for (const delta of deltas) {
    yield { delta, id, type: "text-delta" };
  }
  yield { id, type: "text-end" };
}

/** A run that parks forever at the gate — the crash point. */
export async function* parkAfter(
  chunks: AsyncIterable<UIMessageChunk>,
  gate: Gate
): AsyncGenerator<UIMessageChunk> {
  yield* chunks;
  await gate.passed;
}

export async function* noChunks(): AsyncGenerator<UIMessageChunk> {}

/** Concatenated visible text of a journal (text deltas only). */
export function journalText(entries: JournalEntry[]): string {
  let text = "";
  for (const { chunk } of entries) {
    if (chunk.type === "text-delta") {
      text += chunk.delta;
    }
  }
  return text;
}

export function inbound(
  threadId: string,
  messageId: string,
  text: string
): {
  conversationId: string;
  sourceEventId: string;
  input: Array<{
    id: string;
    role: "user";
    parts: Array<{ type: "text"; text: string }>;
  }>;
} {
  return {
    conversationId: threadId,
    sourceEventId: messageId,
    input: [
      {
        id: messageId,
        parts: [{ text, type: "text" }],
        role: "user"
      }
    ]
  };
}

/**
 * A unique Durable Object name per invocation, so vitest retries never
 * collide with ledger state a failed attempt left behind.
 */
export function freshName(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/** Poll (macrotask ticks via setTimeout 0) until `predicate` holds, bounded. */
export async function until(
  predicate: () => boolean,
  label = "condition"
): Promise<void> {
  for (let i = 0; i < 1_000; i += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
