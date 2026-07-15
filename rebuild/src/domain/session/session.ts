import { z } from "zod";
import { NotFoundError, ValidationError } from "../../kernel/errors.js";
import type { IdSource } from "../../kernel/ids.js";
import type { Clock } from "../../ports/clock.js";
import type { KeyValueStore } from "../../ports/storage.js";
import { isToolPart, toolName, type ChatMessage, type ToolPart } from "../messages/model.js";
import { tool, type ToolSet } from "../tools/types.js";
import {
  applyOverlays,
  estimateMessagesTokens,
  planCompaction,
  renderCompactionPrompt,
  type CompactionConfig,
  type Overlay,
} from "./compaction.js";

// ---------------------------------------------------------------------------
// Context providers
// ---------------------------------------------------------------------------

export interface ContextProviderLike {
  get(): Promise<string>;
  set?(content: string): Promise<void>;
  load?(key: string): Promise<string | null>;
  search?(query: string): Promise<Array<{ key: string; excerpt: string }>>;
  init?(label: string): Promise<void>;
}

export interface ContextBlockConfig {
  label: string;
  description?: string;
  maxTokens?: number;
  provider?: ContextProviderLike;
}

export interface ContextBlockSnapshot {
  label: string;
  description?: string;
  content: string;
  tokens: number;
  maxTokens?: number;
  writable: boolean;
  isSkill: boolean;
  isSearchable: boolean;
}

export interface SessionStatus {
  phase: "idle" | "compacting";
  tokenEstimate: number;
  tokenThreshold?: number;
}

export interface SessionConfig {
  sessionId?: string;
  blocks: ContextBlockConfig[];
  tokenCounter?: (text: string) => number;
  compaction?: CompactionConfig;
  onStatus?: (s: SessionStatus) => void;
  onCompactionError?: (e: unknown) => void;
}

export interface Session {
  appendMessage(m: ChatMessage, parentId?: string): Promise<void>;
  updateMessage(m: ChatMessage): Promise<void>;
  deleteMessages(ids: string[]): Promise<void>;
  clearMessages(): Promise<void>;
  getHistory(leafId?: string): Promise<ChatMessage[]>;
  getLatestLeaf(): Promise<ChatMessage | undefined>;
  getBranches(messageId: string): Promise<ChatMessage[]>;
  getPathLength(): Promise<number>;
  addContext(
    label: string,
    opts?: { description?: string; maxTokens?: number; provider?: ContextProviderLike }
  ): Promise<void>;
  removeContext(label: string): void;
  getContextBlock(label: string): Promise<ContextBlockSnapshot | undefined>;
  replaceContextBlock(label: string, content: string): Promise<void>;
  appendContextBlock(label: string, content: string): Promise<void>;
  freezeSystemPrompt(): Promise<string>;
  refreshSystemPrompt(): Promise<string>;
  tools(): Promise<ToolSet>;
  compact(): Promise<{ compacted: boolean; summaryId?: string }>;
  estimatedTokens(): Promise<number>;
}

// ---------------------------------------------------------------------------
// Internal block runtime state
// ---------------------------------------------------------------------------

interface BlockState {
  label: string;
  description?: string;
  maxTokens?: number;
  provider: ContextProviderLike;
  writable: boolean;
  isSkill: boolean;
  isSearchable: boolean;
  initPromise?: Promise<void>;
}

function classify(
  label: string,
  description: string | undefined,
  maxTokens: number | undefined,
  provider: ContextProviderLike
): BlockState {
  return {
    label,
    description,
    maxTokens,
    provider,
    writable: typeof provider.set === "function",
    isSkill: typeof provider.load === "function",
    isSearchable: typeof provider.search === "function",
  };
}

interface StoredMessage {
  message: ChatMessage;
  parentId: string | null;
}

const ROOT = "__root__";

export function createSession(
  deps: { store: KeyValueStore; clock: Clock; ids: IdSource },
  config: SessionConfig
): Session {
  const sessionId = config.sessionId ?? deps.ids.newId("session");
  const { store } = deps;

  const msgKey = (id: string) => `sess:${sessionId}:msg:${id}`;
  const childrenKey = (parentId: string | null) => `sess:${sessionId}:children:${parentId ?? ROOT}`;
  const leafKey = `sess:${sessionId}:leaf`;
  const overlaysKey = `sess:${sessionId}:overlays`;
  const frozenPromptKey = `sess:${sessionId}:prompt:frozen`;

  function createDefaultProvider(label: string): ContextProviderLike {
    const key = `ctx:${sessionId}:${label}`;
    return {
      async get() {
        return store.get<string>(key) ?? "";
      },
      async set(content: string) {
        store.put(key, content);
      },
    };
  }

  const blocks: BlockState[] = config.blocks.map((b) =>
    classify(b.label, b.description, b.maxTokens, b.provider ?? createDefaultProvider(b.label))
  );

  function findBlock(label: string): BlockState | undefined {
    return blocks.find((b) => b.label === label);
  }

  function ensureInit(block: BlockState): Promise<void> {
    if (!block.provider.init) return Promise.resolve();
    if (!block.initPromise) {
      block.initPromise = block.provider.init(block.label);
    }
    return block.initPromise;
  }

  function estimateText(text: string): number {
    return config.tokenCounter ? config.tokenCounter(text) : Math.ceil(text.length / 4);
  }

  // -- message tree storage --------------------------------------------

  function getLeafId(): string | undefined {
    return store.get<string>(leafKey) ?? undefined;
  }

  function setLeafId(id: string | undefined): void {
    if (id === undefined) store.delete(leafKey);
    else store.put(leafKey, id);
  }

  function getStored(id: string): StoredMessage | undefined {
    return store.get<StoredMessage>(msgKey(id));
  }

  function putStored(row: StoredMessage): void {
    store.put(msgKey(row.message.id), row);
  }

  function getChildren(parentId: string | null): string[] {
    return store.get<string[]>(childrenKey(parentId)) ?? [];
  }

  function addChild(parentId: string | null, childId: string): void {
    const list = getChildren(parentId);
    list.push(childId);
    store.put(childrenKey(parentId), list);
  }

  function removeChild(parentId: string | null, childId: string): void {
    const list = getChildren(parentId).filter((id) => id !== childId);
    store.put(childrenKey(parentId), list);
  }

  function rawHistory(leafId?: string): ChatMessage[] {
    const startId = leafId ?? getLeafId();
    if (!startId) return [];
    const chain: ChatMessage[] = [];
    const seen = new Set<string>();
    let currentId: string | null | undefined = startId;
    while (currentId) {
      // Cycle guard: a corrupted parent edge must degrade to a truncated
      // history, never a synchronous infinite loop (wedges the isolate).
      if (seen.has(currentId)) break;
      seen.add(currentId);
      const stored = getStored(currentId);
      if (!stored) break;
      chain.push(stored.message);
      currentId = stored.parentId;
    }
    return chain.reverse();
  }

  // -- compaction overlays ------------------------------------------------

  function getOverlays(): Overlay[] {
    return store.get<Overlay[]>(overlaysKey) ?? [];
  }

  function setOverlays(list: Overlay[]): void {
    store.put(overlaysKey, list);
  }

  async function estimatedTokensInternal(): Promise<number> {
    const raw = rawHistory();
    const overlaid = applyOverlays(raw, getOverlays());
    const counter = config.compaction?.tokenCounter ?? estimateMessagesTokens;
    return counter(overlaid);
  }

  async function runCompact(): Promise<{ compacted: boolean; summaryId?: string }> {
    const compactionConfig = config.compaction;
    if (!compactionConfig) return { compacted: false };

    const raw = rawHistory();
    const plan = planCompaction(raw, compactionConfig);
    if (!plan) return { compacted: false };

    const idIndex = new Map<string, number>();
    raw.forEach((m, i) => idIndex.set(m.id, i));

    const existing = getOverlays();
    let previousSummary: string | undefined;
    const kept: Overlay[] = [];
    for (const overlay of existing) {
      const f = idIndex.get(overlay.fromMessageId);
      const t = idIndex.get(overlay.toMessageId);
      const supersededByNewRange = f !== undefined && t !== undefined && f >= plan.from && t <= plan.to - 1;
      if (supersededByNewRange) {
        previousSummary = overlay.summary;
        continue;
      }
      kept.push(overlay);
    }

    const rangeMessages = raw.slice(plan.from, plan.to);
    const prompt = renderCompactionPrompt(rangeMessages, previousSummary);

    let summary: string;
    try {
      summary = await compactionConfig.summarize(prompt);
    } catch (err) {
      config.onCompactionError?.(err);
      return { compacted: false };
    }

    const newOverlay: Overlay = {
      id: deps.ids.newId("compaction"),
      fromMessageId: rangeMessages[0]!.id,
      toMessageId: rangeMessages[rangeMessages.length - 1]!.id,
      summary,
    };
    setOverlays([...kept, newOverlay]);
    return { compacted: true, summaryId: newOverlay.id };
  }

  async function afterAppend(): Promise<void> {
    const threshold = config.compaction?.compactAfterTokens;
    let tokenEstimate = await estimatedTokensInternal();

    if (config.compaction && threshold !== undefined && tokenEstimate > threshold) {
      config.onStatus?.({ phase: "compacting", tokenEstimate, tokenThreshold: threshold });
      try {
        await runCompact();
      } catch (err) {
        config.onCompactionError?.(err);
      }
      tokenEstimate = await estimatedTokensInternal();
    }

    config.onStatus?.({ phase: "idle", tokenEstimate, tokenThreshold: threshold });
  }

  // -- loaded-skill reconstruction -----------------------------------------

  function unloadedMarker(key: string): string {
    return `[skill unloaded: ${key}]`;
  }

  function computeLoadedSkills(messages: ChatMessage[]): Map<string, Set<string>> {
    const loaded = new Map<string, Set<string>>();
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const part of message.parts) {
        if (!isToolPart(part) || toolName(part) !== "load_context" || part.state !== "output-available") continue;
        const input = part.input as { label?: string; key?: string } | undefined;
        if (!input?.label || !input.key) continue;
        const set = loaded.get(input.label) ?? new Set<string>();
        if (part.output === unloadedMarker(input.key)) {
          set.delete(input.key);
        } else {
          set.add(input.key);
        }
        loaded.set(input.label, set);
      }
    }
    return loaded;
  }

  function findActiveLoadPart(label: string, key: string): { messageId: string; partIndex: number } | undefined {
    const history = rawHistory();
    const marker = unloadedMarker(key);
    for (let i = history.length - 1; i >= 0; i--) {
      const message = history[i]!;
      if (message.role !== "assistant") continue;
      for (let j = message.parts.length - 1; j >= 0; j--) {
        const part = message.parts[j]!;
        if (!isToolPart(part) || toolName(part) !== "load_context" || part.state !== "output-available") continue;
        const input = part.input as { label?: string; key?: string } | undefined;
        if (input?.label !== label || input?.key !== key) continue;
        if (part.output === marker) return undefined;
        return { messageId: message.id, partIndex: j };
      }
    }
    return undefined;
  }

  function summarizeLoaded(loaded: Map<string, Set<string>>): string {
    const entries: string[] = [];
    for (const [label, keys] of loaded) {
      for (const key of keys) entries.push(`${label}:${key}`);
    }
    return entries.length > 0 ? entries.join(", ") : "none";
  }

  // -- system prompt rendering ---------------------------------------------

  async function renderBlock(block: BlockState): Promise<string> {
    await ensureInit(block);
    const content = await block.provider.get();
    const tokens = estimateText(content);
    const lines: string[] = [block.label.toUpperCase()];
    if (block.description) lines.push(block.description);
    if (block.maxTokens !== undefined) {
      const pct = block.maxTokens > 0 ? Math.round((tokens / block.maxTokens) * 100) : 0;
      lines.push(`[${pct}% — ${tokens}/${block.maxTokens} tokens]`);
    } else if (!block.writable) {
      lines.push("[readonly]");
    }
    lines.push(content);
    return lines.join("\n");
  }

  async function renderPrompt(): Promise<string> {
    const rendered = await Promise.all(blocks.map(renderBlock));
    return rendered.join("\n\n");
  }

  return {
    async appendMessage(m: ChatMessage, parentId?: string): Promise<void> {
      const existing = getStored(m.id);
      if (existing) {
        // Clients round-trip full message arrays, so an append can carry an
        // id we already store. Re-parenting that row onto the current leaf
        // creates a parent CYCLE (the leaf may be its descendant), and
        // rawHistory's chain walk then loops forever — found by the ported
        // reconciliation suite (ISSUE-028). Keep the row's position in the
        // tree; refresh its content only.
        putStored({ message: m, parentId: existing.parentId });
        return;
      }
      const actualParent = parentId ?? getLeafId() ?? null;
      putStored({ message: m, parentId: actualParent });
      addChild(actualParent, m.id);
      setLeafId(m.id);
      await afterAppend();
    },

    async updateMessage(m: ChatMessage): Promise<void> {
      const existing = getStored(m.id);
      if (!existing) throw new NotFoundError(`No message with id ${m.id}`);
      putStored({ message: m, parentId: existing.parentId });
    },

    async deleteMessages(ids: string[]): Promise<void> {
      for (const id of ids) {
        const existing = getStored(id);
        if (!existing) continue;
        removeChild(existing.parentId, id);
        store.delete(msgKey(id));
        store.delete(childrenKey(id));
        if (getLeafId() === id) {
          setLeafId(existing.parentId ?? undefined);
        }
      }
    },

    async clearMessages(): Promise<void> {
      store.deleteAll({ prefix: `sess:${sessionId}:msg:` });
      store.deleteAll({ prefix: `sess:${sessionId}:children:` });
      store.delete(leafKey);
      store.delete(overlaysKey);
    },

    async getHistory(leafId?: string): Promise<ChatMessage[]> {
      const raw = rawHistory(leafId);
      return applyOverlays(raw, getOverlays());
    },

    async getLatestLeaf(): Promise<ChatMessage | undefined> {
      const id = getLeafId();
      if (!id) return undefined;
      return getStored(id)?.message;
    },

    async getBranches(messageId: string): Promise<ChatMessage[]> {
      const children = getChildren(messageId);
      const result: ChatMessage[] = [];
      for (const id of children) {
        const stored = getStored(id);
        if (stored) result.push(stored.message);
      }
      return result;
    },

    async getPathLength(): Promise<number> {
      return rawHistory().length;
    },

    async addContext(
      label: string,
      opts?: { description?: string; maxTokens?: number; provider?: ContextProviderLike }
    ): Promise<void> {
      const provider = opts?.provider ?? createDefaultProvider(label);
      const block = classify(label, opts?.description, opts?.maxTokens, provider);
      const idx = blocks.findIndex((b) => b.label === label);
      if (idx >= 0) blocks[idx] = block;
      else blocks.push(block);
      await ensureInit(block);
    },

    removeContext(label: string): void {
      const idx = blocks.findIndex((b) => b.label === label);
      if (idx >= 0) blocks.splice(idx, 1);
    },

    async getContextBlock(label: string): Promise<ContextBlockSnapshot | undefined> {
      const block = findBlock(label);
      if (!block) return undefined;
      await ensureInit(block);
      const content = await block.provider.get();
      return {
        label: block.label,
        description: block.description,
        content,
        tokens: estimateText(content),
        maxTokens: block.maxTokens,
        writable: block.writable,
        isSkill: block.isSkill,
        isSearchable: block.isSearchable,
      };
    },

    async replaceContextBlock(label: string, content: string): Promise<void> {
      const block = findBlock(label);
      if (!block) throw new NotFoundError(`Unknown context block: ${label}`);
      if (!block.writable) throw new ValidationError(`Context block is read-only: ${label}`);
      await ensureInit(block);
      const tokens = estimateText(content);
      if (block.maxTokens !== undefined && tokens > block.maxTokens) {
        throw new ValidationError(`Content exceeds ${label} limit (${tokens}/${block.maxTokens} tokens)`);
      }
      await block.provider.set!(content);
    },

    async appendContextBlock(label: string, content: string): Promise<void> {
      const block = findBlock(label);
      if (!block) throw new NotFoundError(`Unknown context block: ${label}`);
      if (!block.writable) throw new ValidationError(`Context block is read-only: ${label}`);
      await ensureInit(block);
      const current = await block.provider.get();
      const next = current + content;
      const tokens = estimateText(next);
      if (block.maxTokens !== undefined && tokens > block.maxTokens) {
        throw new ValidationError(`Content exceeds ${label} limit (${tokens}/${block.maxTokens} tokens)`);
      }
      await block.provider.set!(next);
    },

    async freezeSystemPrompt(): Promise<string> {
      const cached = store.get<string>(frozenPromptKey);
      if (cached !== undefined) return cached;
      const rendered = await renderPrompt();
      store.put(frozenPromptKey, rendered);
      return rendered;
    },

    async refreshSystemPrompt(): Promise<string> {
      const rendered = await renderPrompt();
      store.put(frozenPromptKey, rendered);
      return rendered;
    },

    async tools(): Promise<ToolSet> {
      const history = rawHistory();
      const loadedSkills = computeLoadedSkills(history);
      const loadedSummary = summarizeLoaded(loadedSkills);

      const writableBlocks = blocks.filter((b) => b.writable);
      const skillBlocks = blocks.filter((b) => b.isSkill);
      const searchableBlocks = blocks.filter((b) => b.isSearchable);

      const toolSet: ToolSet = {};

      if (writableBlocks.length > 0) {
        toolSet.set_context = tool({
          description: `Write to a context block. Labels: ${writableBlocks.map((b) => b.label).join(", ")}.`,
          inputSchema: z.object({
            label: z.string(),
            content: z.string(),
            action: z.enum(["replace", "append"]),
          }),
          execute: async (input: { label: string; content: string; action: "replace" | "append" }) => {
            const block = findBlock(input.label);
            if (!block || !block.writable) {
              return `Unknown or read-only context label: ${input.label}`;
            }
            await ensureInit(block);
            const current = input.action === "append" ? await block.provider.get() : "";
            const nextContent = input.action === "replace" ? input.content : current + input.content;
            const tokens = estimateText(nextContent);
            if (block.maxTokens !== undefined && tokens > block.maxTokens) {
              const pct = Math.round((tokens / block.maxTokens) * 100);
              return `Rejected: writing to ${block.label} would use ${pct}% (${tokens}/${block.maxTokens} tokens), exceeding the limit.`;
            }
            await block.provider.set!(nextContent);
            if (block.maxTokens !== undefined) {
              const pct = Math.round((tokens / block.maxTokens) * 100);
              return `Written to ${block.label}. Usage: ${pct}% (${tokens}/${block.maxTokens} tokens)`;
            }
            return `Written to ${block.label}.`;
          },
        });
      }

      if (skillBlocks.length > 0) {
        toolSet.load_context = tool({
          description: `Load a document into a skill context block. Labels: ${skillBlocks
            .map((b) => b.label)
            .join(", ")}. Currently loaded: ${loadedSummary}.`,
          inputSchema: z.object({ label: z.string(), key: z.string() }),
          execute: async (input: { label: string; key: string }) => {
            const block = findBlock(input.label);
            if (!block || !block.isSkill) return `Unknown skill context label: ${input.label}`;
            await ensureInit(block);
            const content = await block.provider.load!(input.key);
            if (content === null || content === undefined) return `Not found: ${input.key}`;
            return content;
          },
        });

        toolSet.unload_context = tool({
          description: `Unload a previously loaded document, freeing context. Currently loaded: ${loadedSummary}.`,
          inputSchema: z.object({ label: z.string(), key: z.string() }),
          execute: async (input: { label: string; key: string }) => {
            const found = findActiveLoadPart(input.label, input.key);
            if (!found) return `Not currently loaded: ${input.key}`;
            const stored = getStored(found.messageId);
            if (!stored) return `Not currently loaded: ${input.key}`;
            const newParts = stored.message.parts.map((p, i) =>
              i === found.partIndex ? ({ ...(p as ToolPart), output: unloadedMarker(input.key) } as ToolPart) : p
            );
            putStored({ message: { ...stored.message, parts: newParts }, parentId: stored.parentId });
            return `Unloaded ${input.key} from ${input.label}.`;
          },
        });
      }

      if (searchableBlocks.length > 0) {
        toolSet.search_context = tool({
          description: `Search a context block. Labels: ${searchableBlocks.map((b) => b.label).join(", ")}.`,
          inputSchema: z.object({ label: z.string(), query: z.string() }),
          execute: async (input: { label: string; query: string }) => {
            const block = findBlock(input.label);
            if (!block || !block.isSearchable) return `Unknown searchable context label: ${input.label}`;
            await ensureInit(block);
            const results = await block.provider.search!(input.query);
            if (results.length === 0) return "No results found.";
            return results
              .slice(0, 10)
              .map((r) => `${r.key}: ${r.excerpt}`)
              .join("\n");
          },
        });
      }

      return toolSet;
    },

    async compact(): Promise<{ compacted: boolean; summaryId?: string }> {
      return runCompact();
    },

    async estimatedTokens(): Promise<number> {
      return estimatedTokensInternal();
    },
  };
}
