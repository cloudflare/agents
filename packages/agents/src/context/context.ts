/**
 * Context bound to a session.
 *
 * The session's transcript is the conversation; the request sent to the
 * model is a projection of it. Context never rewrites what the model has
 * already been sent:
 *
 * - The system prompt is a snapshot of the blocks, recorded against the
 *   user message it was first sent with. Every later request opens with
 *   that same snapshot, so the provider's prefix cache holds, until a
 *   refresh records a new one.
 * - A `whenChanged: "remind"` block whose value moves on is delivered as a
 *   reminder after the user message of the turn that noticed it, and that
 *   change is recorded against the same message. The projection renders it
 *   there on every later request, so it is sent once and never moves.
 *
 * The records are session annotations: server-side data the session keeps
 * per message, never part of a message and never sent to a client, deleted
 * with the message. They follow the transcript's tree (branches,
 * regenerations, compaction). Block values live in their providers.
 */

import type { ToolSet } from "ai";
import {
  COMPACTION_PREFIX,
  isCompactionMessage
} from "../sessions/compaction-helpers";
import type { SessionMessage } from "../sessions/types";
import {
  ContextBlocks,
  promptRendersSection,
  renderReminder,
  type ContextBlock,
  type ContextConfig,
  type ContextProvider,
  type WritableContextProvider
} from "./blocks";
import { AgentContextProvider, type SqlProvider } from "./sqlite-provider";

/**
 * @internal Annotation kind of a context record: what a session copy
 * (a fork) carries over with its messages.
 */
export const CONTEXT_RECORD_KIND = "context";
const RECORD = CONTEXT_RECORD_KIND;
/** Session config key of a refresh asked for and not yet recorded. */
const REFRESH = "transcript:context:refresh";

/** One block's prompt section: its label and its rendered text. */
type Section = readonly [label: string, text: string];

/**
 * What Context recorded against one message. Each record is
 * self-contained: with the snapshot it names, it says everything the model
 * had been shown by that message.
 */
type ContextRecord = {
  /** The system prompt from this message on, as ordered sections. */
  readonly system?: readonly Section[];
  /** Blocks that changed, delivered after this message's own content. */
  readonly changes?: readonly Section[];
  /** For a change record: the message that holds its snapshot. */
  readonly base?: string;
  /**
   * Every remind section delivered since the snapshot, these changes
   * included, by label.
   */
  readonly delivered?: readonly Section[];
};

/**
 * The session operations Context uses. A Sessions `Session` handle fits.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface ContextSession {
  readonly sessionId: string;
  getHistory(options?: { leafId?: string | null }): Promise<SessionMessage[]>;
  /** The newest message with no answer: where the next message attaches. */
  getLatestLeaf(): Promise<SessionMessage | null>;
  /** The session's compactions: which stored message each one ends at. */
  getCompactions(): Promise<{ id: string; toMessageId: string }[]>;
  /** @internal */
  internal_annotations(
    kind: string,
    messageIds: readonly string[]
  ): Promise<Map<string, string>>;
  /** @internal */
  internal_setAnnotation(
    kind: string,
    messageId: string,
    value: string
  ): Promise<void>;
  /** @internal */
  internal_latestAnnotation(
    kind: string,
    leafId?: string
  ): Promise<{ messageId: string; value: string } | null>;
  /** @internal */
  internal_config(key: string): Promise<string | null>;
  /** @internal */
  internal_setConfig(key: string, value: string | null): Promise<void>;
}

/**
 * Options for {@link Context}.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface ContextOptions {
  /** The blocks to load. More can be added later with `addBlock()`. */
  readonly blocks?: readonly ContextConfig[];
  /**
   * SQLite for blocks declared without a provider: one row per block in
   * `cf_agents_context_blocks`, keyed by its label (suffixed with the
   * session id outside the default session). Any object with a
   * tagged-template `sql`: an Agent, or `this.lifecycle` on a Durable
   * Object.
   */
  readonly sql?: SqlProvider;
  /** Storage for blocks declared without a provider, instead of SQLite. */
  readonly defaultProvider?: (label: string) => ContextProvider;
  /**
   * A store that also holds the system prompt as text. Read once, when a
   * turn has no recorded prompt on its path, so a prompt frozen before
   * Context (`ContextBlocks`' prompt store) is what those earlier turns are
   * sent with, the first one after the upgrade included. Written with every
   * snapshot Context records; a store whose `set` does nothing keeps the
   * frozen prompt for the earlier turns for good.
   */
  readonly promptStore?: WritableContextProvider;
}

/**
 * What to project: the session's history unless given.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface ContextReadOptions {
  /**
   * The history to work from, root to leaf. Defaults to the session's
   * active path. A host that already holds the transcript, or a bounded
   * window of it, passes it.
   */
  readonly messages?: readonly SessionMessage[];
}

/** @experimental Options of {@link Context.prepare}. */
export interface ContextPrepareOptions extends ContextReadOptions {
  /**
   * This request is another attempt of a turn already sent (chat recovery
   * after a cut, or a retried model call). It is sent as the first attempt
   * was: a change or a pending refresh since then waits for the next turn.
   */
  readonly retry?: boolean;
}

/**
 * The system prompt for a turn, and any reminder the host must place.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface PreparedContext {
  readonly system: string;
  /**
   * Changed blocks that could not be recorded, because the history does not
   * end with a user message nothing has answered yet (a continuation or a
   * regeneration). Send it after the cached prefix of this request only.
   * `null` when there is nothing to place.
   */
  readonly reminder: string | null;
}

/**
 * A model request's context: the system prompt and the projected history.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface BuiltContext extends PreparedContext {
  readonly messages: SessionMessage[];
}

/**
 * Context blocks bound to one session.
 *
 * Call {@link build} at the start of each turn, after the user message is
 * stored, and send what it returns. Use {@link project} for any later
 * request in the same turn. Block reads and writes, and the model's tools,
 * are those of `ContextBlocks`.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class Context {
  readonly #session: ContextSession;
  readonly #blocks: ContextBlocks;
  readonly #promptStore: WritableContextProvider | undefined;
  /**
   * The prompt store's text as first read: the prompt of turns that have no
   * record (sent before Context), so a later snapshot never replaces it.
   */
  #frozen: string | null | undefined;
  /** Whether a refresh waits to be recorded; read from the session once. */
  #refresh: boolean | undefined;
  /** Records by message id, as last read or written (see `#records`). */
  readonly #cache = new Map<
    string,
    { stamp: string | undefined; record: ContextRecord | null }
  >();

  constructor(session: ContextSession, options: ContextOptions = {}) {
    this.#session = session;
    const sql = options.sql;
    const key = (label: string) =>
      session.sessionId ? `${label}_${session.sessionId}` : label;
    const defaultProvider =
      options.defaultProvider ??
      (sql
        ? (label: string) => new AgentContextProvider(sql, key(label))
        : undefined);
    this.#blocks = new ContextBlocks([...(options.blocks ?? [])], {
      defaultProvider
    });
    this.#promptStore = options.promptStore;
  }

  // ── Turns ───────────────────────────────────────────────────────

  /**
   * Prepare a turn and project its history in one call: see
   * {@link prepare} and {@link project}.
   */
  async build(options: ContextReadOptions = {}): Promise<BuiltContext> {
    const history = await this.#history(options);
    const prepared = await this.prepare({ messages: history });
    return { ...prepared, messages: await this.project(history) };
  }

  /**
   * Start a turn. Returns the system prompt to send, and records against
   * the history's last message, when it is a user message nothing has
   * answered yet, what this turn delivers: the first snapshot of the prompt
   * (or a new one after {@link refreshSystemPrompt}), or the remind blocks
   * that changed since the model last saw them.
   */
  async prepare(options: ContextPrepareOptions = {}): Promise<PreparedContext> {
    const history = await this.#history(options);
    const refresh = await this.#refreshPending();
    let delivered = await this.#delivered(history);
    const tail = history.at(-1);
    // Only a user message nothing has answered yet starts a new turn: it is
    // the session's latest leaf. One with answers is a branch point (a
    // regeneration): recording against it would change what its earlier
    // answers were sent.
    let target_: Promise<SessionMessage | undefined> | undefined;
    const target = (): Promise<SessionMessage | undefined> =>
      (target_ ??= (async () =>
        tail?.role === "user" &&
        (await this.#session.getLatestLeaf())?.id === tail.id
          ? tail
          : undefined)());
    // A retry is sent as its first attempt was: no refresh, no new change.
    const retry = options.retry === true;

    if (!delivered.system && !refresh) {
      delivered = await this.#carriedForward(delivered);
    }

    // A pending refresh applies only to a turn that can record it; a
    // regeneration keeps its branch's prompt and leaves the refresh pending.
    const refreshes =
      refresh &&
      (!delivered.system || (!retry && (await target()) !== undefined));
    if (!delivered.system || refreshes) {
      // A new snapshot reads every block afresh, even after a refresh: a
      // block may have changed since the refresh was asked for.
      await this.#blocks.load();
      const sections = await this.#blocks.internal_sections();
      const system = renderSystem(sections);
      // No blocks and no prompt from before: nothing to keep stable.
      if (sections.length === 0 && !delivered.system) {
        if (refresh) await this.#setRefresh(false);
        return { system, reminder: null };
      }
      // A refresh that changes nothing stores nothing new.
      const unchanged =
        delivered.system !== null &&
        renderSystem(delivered.system) === system &&
        sections.every(
          ([label, text]) =>
            !delivered.values.has(label) || delivered.values.get(label) === text
        );
      const at = await target();
      if (at) {
        if (!unchanged) {
          await this.#put(at.id, { system: sections });
          await this.#promptStore?.set(system);
        }
        if (refresh) await this.#setRefresh(false);
      }
      return { system, reminder: null };
    }

    const changes = await this.#changes(delivered.values);
    const system = renderSystem(delivered.system);
    const at =
      delivered.carried || changes.length > 0 ? await target() : undefined;
    if (delivered.carried && at) {
      // The release's frozen prompt becomes this session's first record.
      await this.#put(at.id, {
        system: delivered.system,
        delivered: [...delivered.values].filter(([label]) => label !== CARRIED)
      });
      delivered = { ...delivered, base: at.id };
    }
    if (changes.length === 0) return { system, reminder: null };
    // A turn sent before is sent again exactly; the change waits.
    if (retry) return { system, reminder: null };
    if (!at) {
      return {
        system,
        reminder: renderReminder(changes.map(([, text]) => text))
      };
    }
    // The record names its snapshot and carries everything delivered
    // since, so it alone answers what the model has seen.
    const values = new Map(delivered.values);
    values.delete(CARRIED);
    for (const [label, text] of changes) values.set(label, text);
    const existing = (await this.#records([at.id])).get(at.id);
    await this.#put(at.id, {
      ...existing,
      changes: mergeSections(existing?.changes ?? [], changes),
      ...(delivered.base !== at.id && { base: delivered.base }),
      delivered: [...values]
    });
    return { system, reminder: null };
  }

  /**
   * The history as the model is sent it: each recorded change rendered
   * after the user message it was delivered with. The same history always
   * projects to the same messages.
   */
  async project(
    messages: readonly SessionMessage[]
  ): Promise<SessionMessage[]> {
    const records = await this.#records(messages);
    // A reminder recorded before the latest snapshot is superseded by it:
    // the snapshot holds the value, and the refresh that took it already
    // gave up the cached prefix.
    let start = 0;
    messages.forEach((message, index) => {
      if (records.get(message.id)?.system) start = index;
    });
    const projected: SessionMessage[] = [];
    // Sections waiting for the next user message: a restatement after a
    // summary, or a change found on another message.
    let carried: Section[] = [];
    for (const [index, message] of messages.entries()) {
      const record = index >= start ? records.get(message.id) : undefined;
      if (isCompactionMessage(message)) {
        // The summary was written from the stored messages, which never
        // held a reminder: restate what the hidden turns delivered.
        if (record)
          carried = mergeSections(
            carried,
            await this.#restated(record, records)
          );
        projected.push(message);
        continue;
      }
      const changes = record?.changes ?? [];
      if (message.role !== "user") {
        carried = mergeSections(carried, changes);
        projected.push(message);
        continue;
      }
      // A value this message delivers again is not restated before it.
      const own = new Set(changes.map(([label]) => label));
      const before = carried.filter(([label]) => !own.has(label));
      carried = [];
      const parts = [
        ...(before.length > 0
          ? [textPart(renderReminder(before.map(([, text]) => text)))]
          : []),
        ...message.parts,
        ...(changes.length > 0
          ? [textPart(renderReminder(changes.map(([, text]) => text)))]
          : [])
      ];
      projected.push(
        parts.length === message.parts.length ? message : { ...message, parts }
      );
    }
    if (carried.length > 0) {
      projected.push({
        id: "cf_agents_context_reminder",
        role: "user",
        parts: [textPart(renderReminder(carried.map(([, text]) => text)))]
      });
    }
    return projected;
  }

  // ── System prompt ───────────────────────────────────────────────

  /**
   * The system prompt the history was sent with: its latest snapshot, or
   * what the next turn will send when nothing has been recorded yet. Reads
   * only.
   */
  async freezeSystemPrompt(options: ContextReadOptions = {}): Promise<string> {
    const history = await this.#history(options);
    if (!(await this.#refreshPending())) {
      const delivered = await this.#carriedForward(
        await this.#delivered(history)
      );
      if (delivered.system) return renderSystem(delivered.system);
    }
    return renderSystem(await this.#blocks.internal_sections());
  }

  /**
   * Reload every block and render the prompt from them. The next turn that
   * ends with a user message records it as the new snapshot: the one
   * deliberate cache bust.
   */
  async refreshSystemPrompt(): Promise<string> {
    // Also the step after clearing the transcript (Think does both): the
    // records read so far may belong to messages that are gone.
    this.#cache.clear();
    await this.#blocks.load();
    await this.#setRefresh(true);
    return renderSystem(await this.#blocks.internal_sections());
  }

  /**
   * The remind blocks that changed since the model last saw them, rendered
   * as a reminder, or `null`. Reads only; {@link prepare} delivers them.
   */
  async reminder(options: ContextReadOptions = {}): Promise<string | null> {
    if (await this.#refreshPending()) return null;
    const delivered = await this.#carriedForward(
      await this.#delivered(await this.#history(options))
    );
    if (!delivered.system) return null;
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

  /**
   * Write a writable block. The model sees it at the next refresh, or as a
   * reminder for a remind block.
   */
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
   * The context the model had been shown by the history's last message:
   * the newest record on the stored path to it. The history is usually a
   * window of that path. Its newest record is the path's newest when
   * nothing after it is hidden, which a compaction summary after it would
   * show; otherwise the session walks the stored path, compacted messages
   * included, to the nearest record. So the answer does not depend on how
   * much history the host passes in or on what compaction hides.
   */
  async #delivered(history: readonly SessionMessage[]): Promise<Delivered> {
    const none: Delivered = { system: null, values: new Map() };
    const last = history.at(-1);
    if (!last) return none;

    const records = await this.#records(history);
    let found: { id: string; record: ContextRecord } | undefined;
    for (let index = history.length - 1; index >= 0; index--) {
      const message = history[index];
      const record = records.get(message.id);
      if (record) {
        found = { id: message.id, record };
        break;
      }
    }

    if (!found) {
      let leaf: string | undefined = last.id;
      if (isCompactionMessage(last)) {
        const id = last.id.slice(COMPACTION_PREFIX.length);
        leaf = (await this.#session.getCompactions()).find(
          (compaction) => compaction.id === id
        )?.toMessageId;
      }
      const nearest = leaf
        ? await this.#session.internal_latestAnnotation(RECORD, leaf)
        : null;
      if (nearest) {
        found = {
          id: nearest.messageId,
          record: JSON.parse(nearest.value) as ContextRecord
        };
      }
    }
    if (!found) return none;

    const { id, record } = found;
    if (record.system) {
      const values = new Map<string, string>([
        ...record.system,
        ...(record.delivered ?? [])
      ]);
      for (const [label, text] of record.changes ?? []) {
        values.set(label, text);
      }
      return { system: record.system, values, base: id };
    }
    const baseId = record.base;
    const system = baseId
      ? (await this.#records([baseId])).get(baseId)?.system
      : undefined;
    if (!system || !baseId) return none;
    return {
      system,
      values: new Map([...system, ...(record.delivered ?? [])]),
      base: baseId
    };
  }

  /**
   * A session with no record yet, whose prompt was frozen before Context:
   * that exact text becomes what was sent, so its first request opens with
   * the same bytes. A remind block counts as delivered when the frozen text
   * shows its current section, which is how it was compared before.
   */
  async #carriedForward(delivered: Delivered): Promise<Delivered> {
    if (delivered.system || !this.#promptStore) return delivered;
    this.#frozen ??= await this.#promptStore.get();
    const frozen = this.#frozen;
    if (frozen === null) return delivered;
    const values = new Map<string, string>([[CARRIED, frozen]]);
    for (const [label, text] of await this.#blocks.internal_remindSections()) {
      if (promptRendersSection(frozen, text)) values.set(label, text);
    }
    return { system: [[CARRIED, frozen]], values, carried: true };
  }

  async #refreshPending(): Promise<boolean> {
    this.#refresh ??= (await this.#session.internal_config(REFRESH)) !== null;
    return this.#refresh;
  }

  async #setRefresh(pending: boolean): Promise<void> {
    await this.#session.internal_setConfig(REFRESH, pending ? "1" : null);
    this.#refresh = pending;
  }

  /**
   * What an overlay's record says the hidden turns delivered beyond the
   * snapshot: the remind sections whose text differs from the snapshot's.
   */
  async #restated(
    record: ContextRecord,
    records: ReadonlyMap<string, ContextRecord>
  ): Promise<Section[]> {
    if (record.system) return [...(record.changes ?? [])];
    const base = record.base;
    if (!base) return [];
    const snapshot = (
      records.get(base) ?? (await this.#records([base])).get(base)
    )?.system;
    const sent = new Map<string, string>(snapshot ?? []);
    return (record.delivered ?? []).filter(
      ([label, text]) => sent.get(label) !== text
    );
  }

  /** Remind blocks whose section differs from the one last delivered. */
  async #changes(delivered: ReadonlyMap<string, string>): Promise<Section[]> {
    const current = await this.#blocks.internal_remindSections();
    return current.filter(([label, text]) => delivered.get(label) !== text);
  }

  /**
   * The records of these messages. A record is written only through this
   * instance (`#put`) and an overlay's id is never reused, so a message
   * looked up once is not read again: a turn reads only its new messages.
   * A stored message is matched on its `createdAt` too, so an id reused
   * after a clear or delete is read afresh. The cache holds the last
   * window's ids and is cut back to it when it grows past twice that.
   */
  async #records(
    messages: readonly (SessionMessage | string)[]
  ): Promise<Map<string, ContextRecord>> {
    const stampOf = (message: SessionMessage | string) =>
      typeof message === "string" || isCompactionMessage(message)
        ? undefined
        : String(message.createdAt ?? "");
    const ids = messages.map((message) =>
      typeof message === "string" ? message : message.id
    );
    const missing = messages.filter((message, index) => {
      const cached = this.#cache.get(ids[index]);
      const stamp = stampOf(message);
      return (
        !cached ||
        (stamp !== undefined &&
          cached.stamp !== undefined &&
          cached.stamp !== stamp)
      );
    });
    if (missing.length > 0) {
      const raw = await this.#session.internal_annotations(
        RECORD,
        missing.map((message) =>
          typeof message === "string" ? message : message.id
        )
      );
      for (const message of missing) {
        const id = typeof message === "string" ? message : message.id;
        const value = raw.get(id);
        this.#cache.set(id, {
          stamp: stampOf(message),
          record:
            value === undefined ? null : (JSON.parse(value) as ContextRecord)
        });
      }
    }
    const found = new Map<string, ContextRecord>();
    for (const id of ids) {
      const record = this.#cache.get(id)?.record;
      if (record) found.set(id, record);
    }
    if (this.#cache.size > 2 * ids.length + 64) {
      const keep = new Set(ids);
      for (const id of this.#cache.keys()) {
        if (!keep.has(id)) this.#cache.delete(id);
      }
    }
    return found;
  }

  async #put(id: string, record: ContextRecord): Promise<void> {
    await this.#session.internal_setAnnotation(
      RECORD,
      id,
      JSON.stringify(record)
    );
    const cached = this.#cache.get(id);
    this.#cache.set(id, { stamp: cached?.stamp, record });
  }
}

/** Label of the one section a carried-forward prompt is made of. */
const CARRIED = "";

/** What the model had been shown by a message. */
type Delivered = {
  system: readonly Section[] | null;
  values: Map<string, string>;
  /** The message that holds the snapshot. */
  base?: string;
  /** The snapshot is a prompt frozen before Context, not yet recorded. */
  carried?: boolean;
};

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
