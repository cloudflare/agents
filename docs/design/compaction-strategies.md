# Compaction Strategies

> **Status**: Draft
> **Date**: 2025-02-25

## Overview

Compaction reduces token usage by summarizing older messages while preserving important context. Different strategies trade off between compression ratio, context preservation, and compute cost.

---

## Strategies

### 1. Sliding Window

Keep the most recent N% of messages, summarize the rest into a single summary.

```
Before:  [msg1, msg2, msg3, msg4, msg5, msg6, msg7, msg8, msg9, msg10]
After:   [summary of msg1-7] + [msg8, msg9, msg10]
```

**Config:**

```typescript
{
  strategy: 'sliding_window',
  keepRatio: 0.3,  // keep 30%, summarize 70%
}
```

**Pros:** Simple, predictable, always keeps recent context
**Cons:** May lose important early context

**Used by:** Letta (`sliding_window` mode)

---

### 2. Full Summary

Summarize all messages into a single summary. Most aggressive compression.

```
Before:  [msg1, msg2, msg3, msg4, msg5, msg6, msg7, msg8, msg9, msg10]
After:   [summary of all]
```

**Config:**

```typescript
{
  strategy: 'full_summary',
  maxLength: 2000,  // max summary tokens
}
```

**Pros:** Maximum compression
**Cons:** Loses conversation flow, may miss details

**Used by:** Letta (`all` mode)

---

### 3. Hierarchical (Observer → Reflector)

Two-level compression inspired by human memory. Messages become observations, observations become reflections.

```
Level 0 (raw):        [messages...]           → 50,000 tokens
Level 1 (observe):    [observations...]       → 5,000 tokens (10x compression)
Level 2 (reflect):    [reflections...]        → 500 tokens (100x total)
```

**How it works:**

1. **Observer** runs when messages exceed threshold (e.g., 30k tokens)
   - Extracts key facts, decisions, context
   - Produces concise observations
   - 5-40x compression ratio

2. **Reflector** runs when observations exceed threshold (e.g., 40k tokens)
   - Combines related observations
   - Identifies patterns and themes
   - Further condenses into reflections

**Config:**

```typescript
{
  strategy: 'hierarchical',
  observer: {
    triggerTokens: 30_000,
    model: 'claude-haiku',
    async: true,  // run in background
  },
  reflector: {
    triggerTokens: 40_000,
    model: 'claude-haiku',
    async: true,
  },
}
```

**Pros:** Preserves important info across very long conversations, mimics human memory
**Cons:** More complex, requires multiple LLM calls, higher latency

**Used by:** Mastra (`observationalMemory`)

---

### 4. Selective

Only summarize messages that exceed a relevance or age threshold. Keep important messages intact.

```
Before:  [important1, filler, filler, important2, filler, filler, filler]
After:   [important1, summary of filler] + [important2, summary of filler]
```

**Config:**

```typescript
{
  strategy: 'selective',
  preserve: {
    system: true,
    toolCalls: true,
    tags: ['important', 'decision'],
    maxAge: '1h',  // keep messages < 1 hour old
  },
}
```

**Pros:** Keeps critical context, flexible
**Cons:** Requires heuristics or metadata to identify importance

---

### 5. Self-Compact (Agent-Driven)

The agent itself generates the summary, using its understanding of what's important.

```typescript
{
  strategy: 'self_compact',
  mode: 'sliding_window' | 'all',
  prompt: `Summarize the conversation so far, focusing on:
    - Key decisions made
    - User preferences learned
    - Outstanding tasks or questions`,
}
```

**Pros:** Agent knows what it needs to remember
**Cons:** May be biased, inconsistent quality

**Used by:** Letta (`self_compact_all`, `self_compact_sliding_window` modes)

---

## Comparison

| Strategy           | Compression | Context Loss | Compute | Best For                        |
| ------------------ | ----------- | ------------ | ------- | ------------------------------- |
| **Sliding Window** | Medium      | Low (recent) | Low     | Most use cases                  |
| **Full Summary**   | High        | High         | Low     | Very long, low-detail convos    |
| **Hierarchical**   | Very High   | Low          | High    | Multi-day agents, complex tasks |
| **Selective**      | Variable    | Low          | Medium  | Task-oriented agents            |
| **Self-Compact**   | Variable    | Variable     | Medium  | Autonomous agents               |

---

## Preservation Rules

Regardless of strategy, certain messages should be preserved:

```typescript
interface PreservationRules {
  // Always keep system messages
  system?: boolean;

  // Keep tool call + response pairs together
  toolCalls?: boolean;

  // Keep messages with specific metadata tags
  tags?: string[];

  // Always keep the last N messages
  lastN?: number;

  // Keep messages newer than duration
  maxAge?: Duration;
}
```

**Tool call preservation is critical** — summarizing a tool call without its response (or vice versa) breaks context.

---

## Trigger Conditions

When to run compaction:

```typescript
interface CompactionTrigger {
  // Token-based
  maxTokens?: number; // e.g., 30_000

  // Count-based
  maxMessages?: number; // e.g., 100

  // Time-based
  maxAge?: Duration; // e.g., '24h'

  // Manual only
  manual?: boolean;
}
```

---

## Model Selection

Compaction uses lightweight models for cost/speed:

| Provider  | Recommended Model |
| --------- | ----------------- |
| Anthropic | `claude-haiku`    |
| OpenAI    | `gpt-4o-mini`     |
| Google    | `gemini-flash`    |

---

## Implementation Notes

### Async Compaction

Hierarchical compaction can run in background:

```typescript
// Trigger compaction but don't wait
session.compact({ async: true });

// Or with callback
session.compact({
  async: true,
  onComplete: (result) => {
    /* ... */
  }
});
```

### Incremental vs Full

- **Incremental:** Only compact new messages since last compaction
- **Full:** Re-compact everything (useful after config change)

```typescript
session.compact({ mode: "incremental" }); // default
session.compact({ mode: "full" });
```

---

## References

- [Mastra Observational Memory](https://mastra.ai/docs/memory/observational-memory)
- [Letta Compaction Modes](https://docs.letta.com/compaction)
- [MemGPT Paper](https://arxiv.org/abs/2310.08560) — original hierarchical memory concept
