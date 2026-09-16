/**
 * The engine's transcript mirror: the Agent SDK's `SessionStore`, backed by
 * the Durable Object instead of a disk.
 *
 * Why it exists: Claude Code replays its own transcript, so a host cannot
 * inject assistant history into a fresh container. The only way a new
 * container continues the conversation with full fidelity, signed and
 * redacted thinking included, is to hand the SDK back the exact entries the
 * previous container wrote. The SDK calls `append()` after every local
 * batch and `load()` before it spawns a resumed run, so mirroring those two
 * calls onto the wire is the whole mechanism.
 *
 * Two halves meet here. `append()` writes forward: each batch becomes one
 * or more `engine_log` control frames, small enough that a frame never
 * strains the container leg. `restore()` writes backward: the chunks the
 * Durable Object replays through `configure()` land in the same tables, so
 * `load()` answers with the previous container's transcript followed by
 * whatever this process has appended since.
 *
 * The module is deliberately dependency-free: no SDK import, no wire
 * import, and the emit function is injected, so it can be exercised in a
 * bare Node test without a model, a socket or a subprocess.
 */

/**
 * The byte budget for one `engine_log` frame. Well under the wire's own
 * 128 KiB batch cap, so a batch of frames still fits a single message.
 */
export const MAX_ENGINE_LOG_BYTES = 98_304;
/** Room inside that budget for the frame envelope: type, ids, subpath. */
const ENVELOPE_BYTES = 512;

/**
 * One transcript line. Structurally the SDK's `SessionStoreEntry`, spelled
 * out here so this module imports nothing: every entry has a string `type`,
 * most carry a stable `uuid`, and the rest is opaque JSON.
 */
export type MirrorEntry = {
  readonly type: string;
  readonly uuid?: string;
  readonly [field: string]: unknown;
};

/**
 * Structurally the SDK's `SessionKey`. `projectKey` is ignored: a container
 * serves exactly one session, so `sessionId` and `subpath` already address
 * every transcript we hold, and the project key the SDK derives from the
 * pinned working directory never has to match anything of ours.
 */
export type MirrorKey = {
  readonly projectKey: string;
  readonly sessionId: string;
  /** Undefined for the main transcript, else a subagent or sidecar suffix. */
  readonly subpath?: string;
};

/** The control frame the mirror emits, mirroring `HarnessWireControl`. */
export type EngineLogFrame = {
  readonly type: "engine_log";
  readonly engineSessionId: string;
  readonly subpath: string | null;
  readonly entries: readonly MirrorEntry[];
};

/** How a frame reaches the outbox. Injected so the store stays testable. */
export type EmitEngineLog = (
  operationId: string | null,
  frame: EngineLogFrame
) => void;

/** One chunk of a restore, mirroring `HarnessConfigureRequest.engineLog`. */
export type MirrorChunk = {
  readonly engineSessionId: string;
  readonly subpath: string | null;
  readonly entries: readonly MirrorEntry[];
  readonly chunk: number;
  readonly chunks: number;
};

type Transcript = {
  /** Restore chunks from the Durable Object, keyed by chunk index. */
  readonly restored: Map<number, readonly MirrorEntry[]>;
  /** How many chunks the runtime announced. Zero until one arrives. */
  chunks: number;
  /** What this process appended, in append order. */
  readonly appended: MirrorEntry[];
};

const encoder = new TextEncoder();

export class HarnessSessionStore {
  readonly #emit: EmitEngineLog;
  readonly #activeOperationId: () => string | null;
  readonly #maxFrameBytes: number;
  readonly #transcripts = new Map<string, Transcript>();

  constructor(options: {
    readonly emit: EmitEngineLog;
    /** The turn a mirrored batch belongs to, or null between turns. */
    readonly activeOperationId?: () => string | null;
    readonly maxFrameBytes?: number;
  }) {
    this.#emit = options.emit;
    this.#activeOperationId = options.activeOperationId ?? (() => null);
    this.#maxFrameBytes = options.maxFrameBytes ?? MAX_ENGINE_LOG_BYTES;
  }

  /**
   * Mirror one batch. The SDK has already written it to local disk, so this
   * is best effort by contract: a throw here costs the batch and a
   * `mirror_error` message, never the turn.
   */
  /** Counters for diagnostics: what the SDK asked of this store so far. */
  readonly stats = {
    appends: 0,
    appendedEntries: 0,
    frames: 0,
    loads: 0,
    loadedEntries: 0,
    restoredChunks: 0,
    restoredEntries: 0
  };

  async append(key: MirrorKey, entries: readonly MirrorEntry[]): Promise<void> {
    if (entries.length === 0) return;
    this.stats.appends += 1;
    this.stats.appendedEntries += entries.length;
    const subpath = key.subpath ?? null;
    const transcript = this.#transcript(key.sessionId, subpath);
    transcript.appended.push(...entries);
    const operationId = this.#activeOperationId();
    for (const batch of this.#split(entries)) {
      this.stats.frames += 1;
      this.#emit(operationId, {
        type: "engine_log",
        engineSessionId: key.sessionId,
        subpath,
        entries: batch
      });
    }
  }

  /**
   * The transcript for one key: what the Durable Object restored first,
   * then what this process appended, deduped by `uuid` because a retried
   * batch can re-deliver entries that already landed. Null for a key we
   * know nothing about, which is what tells the SDK to start fresh.
   */
  async load(key: MirrorKey): Promise<MirrorEntry[] | null> {
    const transcript = this.#transcripts.get(
      mapKey(key.sessionId, key.subpath ?? null)
    );
    if (transcript === undefined) return null;
    const entries = dedupe([
      ...restoredEntries(transcript),
      ...transcript.appended
    ]);
    this.stats.loads += 1;
    this.stats.loadedEntries += entries.length;
    return entries.length === 0 ? null : entries;
  }

  /** The subagent transcripts known for one session, for resume. */
  async listSubkeys(key: {
    readonly projectKey: string;
    readonly sessionId: string;
  }): Promise<string[]> {
    const subpaths: string[] = [];
    for (const name of this.#transcripts.keys()) {
      const parsed = parseMapKey(name);
      if (parsed.sessionId !== key.sessionId) continue;
      if (parsed.subpath !== null) subpaths.push(parsed.subpath);
    }
    return subpaths;
  }

  /**
   * Deletion is a no-op: the mirror is append-only, and the Durable Object
   * owns retention for everything it has already stored.
   */
  async delete(_key: MirrorKey): Promise<void> {}

  /**
   * Absorb one chunk of a restore. Idempotent on the chunk index, and
   * insensitive to arrival order: `load()` reassembles by index, so a chunk
   * replayed twice or delivered late costs nothing.
   */
  restore(chunk: MirrorChunk): void {
    this.stats.restoredChunks += 1;
    this.stats.restoredEntries += chunk.entries.length;
    const transcript = this.#transcript(chunk.engineSessionId, chunk.subpath);
    transcript.restored.set(chunk.chunk, chunk.entries);
    transcript.chunks = Math.max(transcript.chunks, chunk.chunks);
  }

  /**
   * True once every chunk of one session's main transcript has arrived.
   * Resuming before that would hand the engine a truncated conversation.
   */
  isComplete(engineSessionId: string): boolean {
    const transcript = this.#transcripts.get(mapKey(engineSessionId, null));
    if (transcript === undefined || transcript.chunks === 0) return false;
    for (let index = 0; index < transcript.chunks; index += 1) {
      if (!transcript.restored.has(index)) return false;
    }
    return true;
  }

  #transcript(sessionId: string, subpath: string | null): Transcript {
    const name = mapKey(sessionId, subpath);
    const existing = this.#transcripts.get(name);
    if (existing !== undefined) return existing;
    const created: Transcript = {
      restored: new Map(),
      chunks: 0,
      appended: []
    };
    this.#transcripts.set(name, created);
    return created;
  }

  /**
   * Fill frames greedily up to the byte budget. An entry is never split
   * across frames: the Durable Object stores entries, not bytes, so an
   * entry that overflows the budget on its own simply rides alone.
   */
  *#split(entries: readonly MirrorEntry[]): Generator<readonly MirrorEntry[]> {
    const budget = Math.max(this.#maxFrameBytes - ENVELOPE_BYTES, 1);
    let batch: MirrorEntry[] = [];
    let bytes = 0;
    for (const entry of entries) {
      // One separator per entry beyond the first.
      const size = encoder.encode(JSON.stringify(entry)).length + 1;
      if (batch.length > 0 && bytes + size > budget) {
        yield batch;
        batch = [];
        bytes = 0;
      }
      batch.push(entry);
      bytes += size;
    }
    if (batch.length > 0) yield batch;
  }
}

/** The restored chunks of one transcript, in chunk order. */
function restoredEntries(transcript: Transcript): readonly MirrorEntry[] {
  const indexes = [...transcript.restored.keys()].sort((a, b) => a - b);
  return indexes.flatMap((index) => [
    ...(transcript.restored.get(index) ?? [])
  ]);
}

/** First occurrence wins. Entries without a `uuid` are never deduped. */
function dedupe(entries: readonly MirrorEntry[]): MirrorEntry[] {
  const seen = new Set<string>();
  const kept: MirrorEntry[] = [];
  for (const entry of entries) {
    const uuid = entry.uuid;
    if (typeof uuid === "string") {
      if (seen.has(uuid)) continue;
      seen.add(uuid);
    }
    kept.push(entry);
  }
  return kept;
}

/** A null byte cannot appear in a session id or a subpath, so it separates. */
function mapKey(sessionId: string, subpath: string | null): string {
  return `${sessionId}\u0000${subpath ?? ""}`;
}

function parseMapKey(name: string): {
  readonly sessionId: string;
  readonly subpath: string | null;
} {
  const cut = name.indexOf("\u0000");
  const subpath = name.slice(cut + 1);
  return {
    sessionId: name.slice(0, cut),
    subpath: subpath === "" ? null : subpath
  };
}
