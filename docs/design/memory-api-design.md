# Memory API Design for Agents SDK

> **Status**: Draft
> **Date**: 2025-02-25

## Overview

Three memory tiers with pluggable storage providers.

```
┌─────────────────────────────────────────────────────────────┐
│                      MEMORY SYSTEM                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  SESSION MEMORY        WORKING MEMORY       LONG-TERM       │
│  ┌──────────────┐     ┌──────────────┐     ┌─────────────┐ │
│  │ messages     │     │ blocks       │     │ passages    │ │
│  │ tool calls   │     │ (in prompt)  │     │ (searchable)│ │
│  │              │     │              │     │             │ │
│  │ compactable  │     │ AI editable  │     │ AI writable │ │
│  └──────┬───────┘     └──────────────┘     └──────┬──────┘ │
│         │                                         │        │
│         └────── auto-archive to ─────────────────►│        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Session Memory

Stores conversation history. Supports compaction.

```typescript
interface SessionMemory {
  // Read
  getMessages(options?: GetMessagesOptions): Promise<Message[]>;
  count(): Promise<number>;

  // Write
  append(messages: Message | Message[]): Promise<void>;
  deleteMessages(messageIds: string[]): Promise<void>;
  clear(): Promise<void>;

  // Compaction
  compact(options?: CompactOptions): Promise<CompactResult>;
  getSummaries(): Promise<Summary[]>;
}

interface GetMessagesOptions {
  limit?: number;
  offset?: number;
  role?: 'user' | 'assistant' | 'system' | 'tool';
  after?: Date;
  before?: Date;
  includeSummaries?: boolean;
}

interface CompactOptions {
  strategy: 'sliding_window' | 'full_summary' | 'hierarchical';
  model?: string;
  keepRatio?: number;           // for sliding_window
  preserveSystem?: boolean;
  preserveToolCalls?: boolean;  // keep tool call/response pairs intact
}

interface CompactResult {
  summaries: Message[];
  compactedCount: number;
  retainedCount: number;
  stats: { originalTokens: number; finalTokens: number };
}
```

---

## Working Memory

Blocks that are always in the prompt. AI can edit via tools.

```typescript
interface WorkingMemory {
  // Read
  get(): Promise<Record<string, MemoryBlock>>;
  getBlock(label: string): Promise<MemoryBlock | null>;
  listBlocks(): Promise<MemoryBlock[]>;

  // Write
  setBlock(label: string, content: string, options?: BlockOptions): Promise<void>;
  appendToBlock(label: string, content: string): Promise<void>;
  replaceInBlock(label: string, oldContent: string, newContent: string): Promise<void>;
  deleteBlock(label: string): Promise<void>;
  clear(): Promise<void>;
}

interface MemoryBlock {
  label: string;
  content: string;
  limit: number;       // max characters
  length: number;      // current characters
  description?: string; // hint for AI
}

interface BlockOptions {
  limit?: number;
  description?: string;
}
```

**AI Tools exposed:**
- `core_memory_append(block, content)`
- `core_memory_replace(block, old, new)`

---

## Long-Term Memory

Searchable passages. AI can search and write via tools. Sessions auto-archive here.

```typescript
interface LongTermMemory {
  // Read
  get(id: string): Promise<Passage | null>;
  list(options?: ListOptions): Promise<Passage[]>;

  // Write
  insert(passage: PassageInput): Promise<Passage>;
  insertBatch(passages: PassageInput[]): Promise<Passage[]>;
  update(id: string, updates: Partial<PassageInput>): Promise<Passage>;
  delete(id: string): Promise<void>;

  // Search (if SearchProvider attached)
  search?(query: string, options?: SearchOptions): Promise<SearchResult[]>;

  // Indexing
  indexDocument(doc: DocumentInput): Promise<Passage[]>;
}

interface Passage {
  id: string;
  text: string;
  embedding?: number[];
  source?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

interface PassageInput {
  text: string;
  source?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

interface SearchOptions {
  topK?: number;
  minScore?: number;
  tags?: string[];
  source?: string;
}

interface SearchResult {
  passage: Passage;
  score: number;
}

interface DocumentInput {
  content: string;
  source: string;
  chunking?: { chunkSize?: number; overlap?: number };
  tags?: string[];
}
```

**AI Tools exposed:**
- `memory_search(query, options)` — if SearchProvider attached
- `memory_store(text, tags?, source?)` — always available

---

## Provider Pattern

```typescript
// Storage only - CRUD operations
interface StorageProvider {
  get(id: string): Promise<Passage | null>;
  put(passage: Passage): Promise<void>;
  delete(id: string): Promise<void>;
  list(options?: ListOptions): Promise<Passage[]>;
}

// Search capability - can be separate or combined
interface SearchProvider {
  search(query: string, embedding: number[], options?: SearchOptions): Promise<SearchResult[]>;
}

// Embedding generation
interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}
```

**Composition:**

```typescript
// Long-term memory accepts storage, optionally wrapped with search
const memory = new LongTermMemory({
  storage: new R2Provider(env.BUCKET),
  // No search - agent uses codemode to query
});

const memory = new LongTermMemory({
  storage: new R2Provider(env.BUCKET),
  search: new VectorizeProvider(env.VECTORIZE),
  embeddings: new WorkersAIProvider(env.AI),
  // Has search - exposes memory_search tool
});

// Or native provider that does both
const memory = new LongTermMemory({
  storage: new AISearchProvider(env.AI_SEARCH),
  // Has search built-in - exposes memory_search tool
});
```

**When SearchProvider is attached:**
- `memory.search()` method becomes available
- `memory_search` tool is exposed to AI

---

## Session → Long-Term Archive

Sessions automatically flow to long-term memory:

```typescript
interface ArchiveOptions {
  // When to archive
  trigger: 'on_compact' | 'on_session_end' | 'manual';

  // What to archive
  include: 'summaries' | 'all_messages' | 'both';

  // How to tag
  tags?: string[];
  sourcePrefix?: string; // e.g., "session:"
}
```

---

## Configuration

```typescript
interface MemoryConfig {
  session?: {
    provider: StorageProvider;
    compaction?: {
      auto?: boolean;
      maxTokens?: number;
      maxMessages?: number;
      strategy?: CompactOptions['strategy'];
    };
    archive?: ArchiveOptions;
  };

  working?: {
    provider: StorageProvider;
    blocks?: Record<string, BlockOptions>; // predefined blocks
  };

  longTerm?: {
    storage: StorageProvider;
    search?: SearchProvider;
    embeddings?: EmbeddingProvider;
  };
}
```

---

## Summary

| Memory | Stores | Compaction | AI Writes | AI Reads | Auto-flow |
|--------|--------|------------|-----------|----------|-----------|
| **Session** | messages, tools | Yes | append | getMessages | → Long-term |
| **Working** | blocks | No | append, replace | in prompt | — |
| **Long-term** | passages | No | store | search (if provider) | ← Session |
