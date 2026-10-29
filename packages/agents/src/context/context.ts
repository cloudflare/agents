/**
 * Context bound to a session.
 *
 * The session's transcript is the record; the request sent to the model is
 * a projection of it. Context never rewrites what the model has already
 * been sent:
 *
 * - The system prompt is a snapshot of the blocks, stored on the user
 *   message it was first sent with. Every later request opens with that
 *   same snapshot, so the provider's prefix cache holds, until a refresh
 *   stores a new one.
 * - A `whenChanged: "remind"` block whose value moves on is delivered as a
 *   reminder after the user message of the turn that noticed it, and that
 *   change is stored on the same message. The projection renders it there
 *   on every later request, so it is sent once and never moves.
 *
 * Block values live in their providers, as before; the transcript records
 * only what the model was shown and where.
 */

import type { ToolSet } from "ai";
import type { SessionMessage } from "../sessions/types";
import {
  ContextBlocks,
  isWritableProvider,
  renderReminder,
  type ContextBlock,
  type ContextConfig,
  type ContextProvider,
  type WritableContextProvider
} from "./blocks";
import { AgentContextProvider, type SqlProvider } from "./sqlite-provider";

/**
 * Message-metadata key Context stores its record under. Hosts that accept
 * messages from clients should treat it as server-owned (for example, list
 * it in `Sessions` `reservedMetadataKeys`), so a client cannot forge a
 * prompt.
 */
export const CONTEXT_METADATA_KEY = "cf_agents_context";

/** One block's prompt section: its label and its rendered text. */
type Section = readonly [label: string, text: string];

/** What a message records about the context the model was sent with it. */
type ContextRecord = {
  /** The system prompt from this message on, as ordered sections. */
  readonly system?: readonly Section[];
  /** Blocks that changed, delivered after this message's own content. */
  readonly changes?: readonly Section[];
};

/** The session operations Context uses. A Sessions `Session` handle fits. */
export interface ContextSession {
  readonly sessionId: string;
  getHistory(options?: { leafId?: string | null }): Promise<SessionMessage[]>;
  getMessage(id: string): Promise<SessionMessage | null>;
  /** The answers to a message: its children in the transcript tree. */
  getBranches(messageId: string): Promise<SessionMessage[]>;
  updateMessage(message: SessionMessage): Promise<SessionMessage | null>;
}

/**
 * What Context keeps beside the transcript: where the latest snapshot is,
 * for a history read that starts after it, and a refresh that has not been
 * recorded yet.
 */
type ContextState = {
  readonly snapshot?: string;
  readonly refresh?: boolean;
};

/** Block label of the stored {@link ContextState}. */
const STATE_LABEL = "_context_state";

/** Options for {@link Context}. */
export interface ContextOptions {
  /** The blocks to load. More can be added later with `addBlock()`. */
  readonly blocks?: readonly ContextConfig[];
  /**
   * Storage for blocks declared without a provider. Overrides `storage`.
   * Context also keeps a small state row here (label `_context_state`), so
   * a pending refresh survives eviction; without storage it lives in
   * memory.
   */
  readonly defaultProvider?: (label: string) => ContextProvider;
  /**
   * Durable Object storage for blocks declared without a provider: one row
   * per block in `cf_agents_context_blocks`, keyed by label (suffixed with
   * the session id outside the default session).
   */
  readonly storage?: DurableObjectStorage;
}

/** What to project: the session's history unless given. */
export interface ContextReadOptions {
  /**
   * The history to work from, root to leaf. Defaults to the session's
   * active path. A host that already holds the transcript passes it.
   */
  readonly messages?: readonly SessionMessage[];
}

/** The system prompt for a turn, and any reminder the host must place. */
export interface PreparedContext {
  readonly system: string;
  /**
   * Changed blocks that could not be recorded because the history does not
   * end with a user message (a continuation, for example). Send it after
   * the cached prefix; the next turn that ends with a user message records
   * it. `null` when there is nothing to place.
   */
  readonly reminder: string | null;
}

/** A model request's context: the system prompt and the projected history. */
export interface BuiltContext extends PreparedContext {
  readonly messages: SessionMessage[];
}

/**
 * Context blocks bound to one session.
 *
 * Call {@link build} at the start of each turn, after the user message is
 * stored, and send what it returns. Use {@link project} for any later
 * request in the same turn. Block reads and writes, and the model's tools,
 * work as they do on `ContextBlocks`.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class Context {
  readonly #session: ContextSession;
  readonly #blocks: ContextBlocks;
  /** Durable home of {@link ContextState}, when there is storage. */
  readonly #stateStore: WritableContextProvider | undefined;
  /** {@link ContextState} for a Context without storage. */
  #memoryState: ContextState = {};

  constructor(session: ContextSession, options: ContextOptions = {}) {
    this.#session = session;
    const key = (label: string) =>
      session.sessionId ? `${label}_${session.sessionId}` : label;
    const storage = options.storage;
    const defaultProvider =
      options.defaultProvider ??
      (storage
        ? (label: string) =>
            new AgentContextProvider(storageSql(storage), key(label))
        : undefined);
    this.#blocks = new ContextBlocks(
      [...(options.blocks ?? [])],
      undefined,
      defaultProvider
    );
    const stateStore = defaultProvider?.(STATE_LABEL);
    this.#stateStore = isWritableProvider(stateStore) ? stateStore : undefined;
  }

  // ── Turns ───────────────────────────────────────────────────────

  /**
   * Prepare a turn and project its history in one call: see
   * {@link prepare} and {@link project}.
   */
  async build(options: ContextReadOptions = {}): Promise<BuiltContext> {
    const history = await this.#history(options);
    const prepared = await this.prepare({ messages: history });
    // Preparing may have recorded on the last message; project the stored
    // form so this request renders what later ones will.
    const tail = history.at(-1);
    const stored =
      tail && prepared.recorded
        ? ((await this.#session.getMessage(tail.id)) ?? tail)
        : tail;
    const messages = this.project(
      stored && stored !== tail ? [...history.slice(0, -1), stored] : history
    );
    return {
      system: prepared.system,
      reminder: prepared.reminder,
      messages
    };
  }

  /**
   * Start a turn. Returns the system prompt to send, and records on the
   * history's last message, when it is a user message, what this turn
   * delivers: the first snapshot of the prompt (or a new one after
   * {@link refreshSystemPrompt}), or the remind blocks that changed since
   * the model last saw them.
   */
  async prepare(
    options: ContextReadOptions = {}
  ): Promise<PreparedContext & { readonly recorded: boolean }> {
    const history = await this.#history(options);
    const state = await this.#readState();
    const delivered = await this.#delivered(history, state);
    const tail = history.at(-1);
    // Only a user message nothing has answered yet starts a new turn. One
    // with answers is a branch point (a regeneration): recording on it would
    // change what its earlier answers were sent.
    const recordable =
      tail?.role === "user" &&
      (await this.#session.getBranches(tail.id)).length === 0;

    if (!delivered.system || state.refresh) {
      // A new snapshot reads every block afresh, as a refresh does.
      if (!state.refresh) await this.#blocks.load();
      const sections = await this.#blocks.internal_sections();
      if (recordable) {
        await this.#record(tail, { system: sections });
        await this.#writeState({ snapshot: tail.id });
      }
      return {
        system: renderSystem(sections),
        reminder: null,
        recorded: recordable
      };
    }

    const changes = await this.#changes(delivered.values);
    const system = renderSystem(delivered.system);
    if (changes.length === 0) {
      return { system, reminder: null, recorded: false };
    }
    if (recordable) {
      await this.#record(tail, { changes });
      return { system, reminder: null, recorded: true };
    }
    return {
      system,
      reminder: renderReminder(changes.map(([, text]) => text)),
      recorded: false
    };
  }

  /**
   * The history as the model is sent it: each recorded change rendered
   * after the user message it was delivered with. Pure; the same history
   * always projects to the same messages.
   */
  project(messages: readonly SessionMessage[]): SessionMessage[] {
    const projected: SessionMessage[] = [];
    let carried: string[] = [];
    for (const message of messages) {
      const changes = recordOf(message)?.changes;
      const reminder =
        changes && changes.length > 0
          ? renderReminder(changes.map(([, text]) => text))
          : undefined;
      if (message.role !== "user") {
        // Changes are recorded on user messages; one found elsewhere rides
        // on the next user message.
        if (reminder) carried.push(reminder);
        projected.push(message);
        continue;
      }
      const before = carried.map(textPart);
      carried = [];
      const after = reminder ? [textPart(reminder)] : [];
      projected.push(
        before.length === 0 && after.length === 0
          ? message
          : { ...message, parts: [...before, ...message.parts, ...after] }
      );
    }
    if (carried.length > 0) {
      projected.push({
        id: `${CONTEXT_METADATA_KEY}_reminder`,
        role: "user",
        parts: carried.map(textPart)
      });
    }
    return projected;
  }

  // ── System prompt ───────────────────────────────────────────────

  /**
   * The system prompt the history was sent with: its latest snapshot, or
   * the blocks rendered now when nothing has been recorded yet. Reads only.
   */
  async freezeSystemPrompt(options: ContextReadOptions = {}): Promise<string> {
    const state = await this.#readState();
    const delivered = await this.#delivered(
      await this.#history(options),
      state
    );
    if (delivered.system && !state.refresh) {
      return renderSystem(delivered.system);
    }
    return renderSystem(await this.#blocks.internal_sections());
  }

  /**
   * Reload every block and render the prompt from them. The next turn that
   * ends with a user message records it as the new snapshot: the one
   * deliberate cache bust.
   */
  async refreshSystemPrompt(): Promise<string> {
    await this.#blocks.load();
    await this.#writeState({ ...(await this.#readState()), refresh: true });
    return renderSystem(await this.#blocks.internal_sections());
  }

  /**
   * The remind blocks that changed since the model last saw them, rendered
   * as a reminder, or `null`. Reads only; {@link prepare} delivers them.
   */
  async reminder(options: ContextReadOptions = {}): Promise<string | null> {
    const state = await this.#readState();
    const delivered = await this.#delivered(
      await this.#history(options),
      state
    );
    if (!delivered.system || state.refresh) return null;
    const changes = await this.#changes(delivered.values);
    return changes.length > 0
      ? renderReminder(changes.map(([, text]) => text))
      : null;
  }

  // ── Blocks ──────────────────────────────────────────────────────

  /** Load every block from its provider. Other calls load lazily. */
  load(): Promise<void> {
    return this.#blocks.load();
  }

  getBlock(label: string): ContextBlock | null {
    return this.#blocks.getBlock(label);
  }

  getBlocks(): ContextBlock[] {
    return this.#blocks.getBlocks();
  }

  /** Write a writable block. The model sees it at the next refresh, or as a reminder for a remind block. */
  setBlock(label: string, content: string): Promise<ContextBlock> {
    return this.#blocks.setBlock(label, content);
  }

  appendToBlock(label: string, content: string): Promise<ContextBlock> {
    return this.#blocks.appendToBlock(label, content);
  }

  /** Add a block. It enters the prompt at the next refresh. */
  addBlock(config: ContextConfig): Promise<ContextBlock> {
    return this.#blocks.addBlock(config);
  }

  /** Remove a block. It leaves the prompt at the next refresh. */
  removeBlock(label: string): boolean {
    return this.#blocks.removeBlock(label);
  }

  /** The model's tools for these blocks: `set_context`, `search_context`. */
  tools(): Promise<ToolSet> {
    return this.#blocks.tools();
  }

  // ── Internal ────────────────────────────────────────────────────

  async #history(options: ContextReadOptions): Promise<SessionMessage[]> {
    return options.messages
      ? [...options.messages]
      : await this.#session.getHistory();
  }

  /**
   * The context a history was delivered with. When the history starts
   * after the latest snapshot (a host's bounded window), the stored pointer
   * finds it.
   */
  async #delivered(
    history: readonly SessionMessage[],
    state: ContextState
  ): Promise<Delivered> {
    const delivered = deliveredContext(history);
    if (delivered.system || !state.snapshot) return delivered;
    const message = await this.#session.getMessage(state.snapshot);
    const system = message ? recordOf(message)?.system : undefined;
    if (!system) return delivered;
    return deliveredContext([message as SessionMessage, ...history]);
  }

  async #readState(): Promise<ContextState> {
    if (!this.#stateStore) return this.#memoryState;
    const raw = await this.#stateStore.get();
    if (!raw) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      return isObject(parsed) ? (parsed as ContextState) : {};
    } catch {
      return {};
    }
  }

  async #writeState(state: ContextState): Promise<void> {
    if (!this.#stateStore) {
      this.#memoryState = state;
      return;
    }
    await this.#stateStore.set(JSON.stringify(state));
  }

  /** Remind blocks whose section differs from the one last delivered. */
  async #changes(delivered: ReadonlyMap<string, string>): Promise<Section[]> {
    const current = await this.#blocks.internal_remindSections();
    return current.filter(([label, text]) => delivered.get(label) !== text);
  }

  /** Merge a record into a stored message's metadata. */
  async #record(message: SessionMessage, record: ContextRecord): Promise<void> {
    const stored = (await this.#session.getMessage(message.id)) ?? message;
    const metadata = isObject(stored.metadata) ? stored.metadata : {};
    const existing = recordOf(stored) ?? {};
    const merged: ContextRecord = record.system
      ? { system: record.system }
      : {
          ...existing,
          changes: mergeSections(existing.changes ?? [], record.changes ?? [])
        };
    await this.#session.updateMessage({
      ...stored,
      metadata: { ...metadata, [CONTEXT_METADATA_KEY]: merged }
    });
  }
}

/**
 * Replay a history's records: the latest snapshot, and each block's section
 * as last delivered (the snapshot, then any change recorded from there on).
 */
type Delivered = {
  system: readonly Section[] | null;
  values: Map<string, string>;
};

function deliveredContext(history: readonly SessionMessage[]): Delivered {
  let system: readonly Section[] | null = null;
  let start = 0;
  history.forEach((message, index) => {
    const recorded = recordOf(message)?.system;
    if (recorded) {
      system = recorded;
      // A snapshot message may also carry changes delivered with it.
      start = index;
    }
  });
  const values = new Map<string, string>(system ?? []);
  for (let index = start; index < history.length; index++) {
    for (const [label, text] of recordOf(history[index])?.changes ?? []) {
      values.set(label, text);
    }
  }
  return { system, values };
}

function recordOf(message: SessionMessage): ContextRecord | undefined {
  const metadata = message.metadata;
  if (!isObject(metadata)) return undefined;
  const record = metadata[CONTEXT_METADATA_KEY];
  return isObject(record) ? (record as ContextRecord) : undefined;
}

function renderSystem(sections: readonly Section[]): string {
  return sections
    .map(([, text]) => text)
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/** Later sections replace earlier ones with the same label, in place. */
function mergeSections(
  earlier: readonly Section[],
  later: readonly Section[]
): Section[] {
  const merged = new Map<string, string>(earlier);
  for (const [label, text] of later) merged.set(label, text);
  return [...merged];
}

function textPart(text: string) {
  return { type: "text", text };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The tagged-template SQL the SQLite providers take, over DO storage. */
function storageSql(storage: DurableObjectStorage): SqlProvider {
  return {
    sql: <T>(
      strings: TemplateStringsArray,
      ...values: (string | number | boolean | null)[]
    ) =>
      // SAFETY: the providers select their own columns; T names them.
      [
        ...storage.sql.exec(
          strings.join("?"),
          ...values.map((value) =>
            typeof value === "boolean" ? Number(value) : value
          )
        )
      ] as T[]
  };
}
