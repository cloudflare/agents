import type { Clock } from "../../ports/clock.js";
import type { KeyValueStore } from "../../ports/storage.js";
import type { UiChunk } from "./chunks.js";

const DEFAULT_SETTLED_MS = 600_000; // 10 minutes
const DEFAULT_ABANDONED_MS = 3_600_000; // 1 hour

/** Reserved key that can never collide with a caller-supplied streamId. */
const ACTIVE_POINTER_KEY = "__active__";

type StreamStatus = "active" | "completed" | "errored";

interface StreamRecord {
  kind: "stream";
  requestId: string;
  status: StreamStatus;
  chunks: UiChunk[];
  /** Set on begin(), used to measure abandonment of active streams. */
  lastChunkAt: number;
  /** Set on settle(), used to measure retention of settled streams. */
  settledAt?: number;
}

interface ActivePointer {
  kind: "pointer";
  streamId: string;
  requestId: string;
}

type StoredValue = StreamRecord | ActivePointer;

export interface ResumableStreamBuffer {
  begin(streamId: string, requestId: string): void;
  append(streamId: string, chunk: UiChunk): void;
  settle(streamId: string, outcome: "completed" | "errored"): void;
  /** null if unknown/reclaimed. */
  read(streamId: string): { chunks: UiChunk[]; status: StreamStatus; requestId: string } | null;
  activeStream(): { streamId: string; requestId: string } | null;
  /** Returns the number of streams reclaimed. */
  gc(): number;
}

/**
 * Persists the chunks of an active turn's UI stream so a reconnecting client
 * can replay from the start and continue live. State lives entirely in
 * `deps.store` (already scoped to a "stream:" prefix by the caller), so a
 * buffer recreated over the same store picks up exactly where the previous
 * one left off.
 */
export function createResumableStreamBuffer(deps: {
  store: KeyValueStore;
  clock: Clock;
  retention?: { settledMs?: number; abandonedMs?: number };
}): ResumableStreamBuffer {
  const { store, clock } = deps;
  const settledMs = deps.retention?.settledMs ?? DEFAULT_SETTLED_MS;
  const abandonedMs = deps.retention?.abandonedMs ?? DEFAULT_ABANDONED_MS;

  function getRecord(streamId: string): StreamRecord | undefined {
    const value = store.get<StoredValue>(streamId);
    return value?.kind === "stream" ? value : undefined;
  }

  function getPointer(): ActivePointer | undefined {
    const value = store.get<StoredValue>(ACTIVE_POINTER_KEY);
    return value?.kind === "pointer" ? value : undefined;
  }

  function clearPointerIfPointingAt(streamId: string): void {
    const pointer = getPointer();
    if (pointer?.streamId === streamId) {
      store.delete(ACTIVE_POINTER_KEY);
    }
  }

  return {
    begin(streamId: string, requestId: string): void {
      const record: StreamRecord = {
        kind: "stream",
        requestId,
        status: "active",
        chunks: [],
        lastChunkAt: clock.now(),
      };
      store.put(streamId, record);
      // A new stream always supersedes whatever the active pointer held; the
      // caller (turn queue) is responsible for having settled the previous
      // stream first.
      const pointer: ActivePointer = { kind: "pointer", streamId, requestId };
      store.put(ACTIVE_POINTER_KEY, pointer);
    },

    append(streamId: string, chunk: UiChunk): void {
      const record = getRecord(streamId);
      if (record === undefined || record.status !== "active") return;
      record.chunks.push(chunk);
      record.lastChunkAt = clock.now();
      store.put(streamId, record);
    },

    settle(streamId: string, outcome: "completed" | "errored"): void {
      const record = getRecord(streamId);
      if (record === undefined) return;
      record.status = outcome;
      record.settledAt = clock.now();
      store.put(streamId, record);
      clearPointerIfPointingAt(streamId);
    },

    read(streamId: string): { chunks: UiChunk[]; status: StreamStatus; requestId: string } | null {
      const record = getRecord(streamId);
      if (record === undefined) return null;
      return { chunks: [...record.chunks], status: record.status, requestId: record.requestId };
    },

    activeStream(): { streamId: string; requestId: string } | null {
      const pointer = getPointer();
      if (pointer === undefined) return null;
      const record = getRecord(pointer.streamId);
      if (record === undefined || record.status !== "active") return null;
      return { streamId: pointer.streamId, requestId: pointer.requestId };
    },

    gc(): number {
      const now = clock.now();
      let reclaimed = 0;
      for (const [key, value] of store.list<StoredValue>()) {
        if (value.kind !== "stream") continue;
        if (value.status === "active") {
          if (now - value.lastChunkAt >= abandonedMs) {
            store.delete(key);
            clearPointerIfPointingAt(key);
            reclaimed++;
          }
        } else if (value.settledAt !== undefined && now - value.settledAt >= settledMs) {
          store.delete(key);
          reclaimed++;
        }
      }
      return reclaimed;
    },
  };
}
