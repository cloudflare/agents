---
"@cloudflare/think": patch
"agents": patch
---

Add opt-in recovery for mid-turn context-window overflow.

Compaction only fires between turns (`Session.compactAfter` checks the threshold on `appendMessage`). A single long, tool-heavy turn grows the prompt step-by-step inside one `streamText` loop and can exceed the model's context window mid-turn, before the next pre-turn check — the provider then 400s (`"prompt is too long"` / `context_length_exceeded`) and the turn dies terminally. Think deliberately ships no provider-specific error matching, so it could neither detect nor recover from this.

This adds opt-in, provider-agnostic recovery (all default off — no behavior change unless enabled), configured through a single `contextOverflow` property on `Think`:

- **`classifyChatError(error, ctx)`** — the app maps a raw error (or the in-stream error string) to a `ChatErrorClassification` (`"context_overflow" | "rate_limit" | "transient" | "fatal" | "unknown"`). Same framework-owns-the-mechanism / app-owns-the-provider-knowledge split as `tokenCounter`. The classification is also threaded to `onChatError`/observers via `ChatErrorContext.classification`. The bundled, exported `defaultContextOverflowClassifier` covers the common providers (Anthropic, OpenAI, Google, Bedrock, …) for apps that do not need custom classification.
- **`contextOverflow.reactive`** + **`contextOverflow.maxRetries`** — when a turn fails with a `context_overflow` the app classified, Think discards the truncated partial, runs `session.compact()`, and re-runs the turn (bounded) from the compacted history instead of dying. The partial is intentionally not persisted: the retry restarts the turn from scratch, so keeping the cut-off partial would orphan a half-finished assistant message beside the recovered answer (and duplicate any tool work the retry re-issues). A no-op compaction or a spent budget surfaces the overflow terminally through `onChatError` with `classification: "context_overflow"` — never a silent end, never an infinite loop. Wired into the WebSocket, `chat()`/RPC, and programmatic (`saveMessages`/`submitMessages`) turn paths.
- **`contextOverflow.proactive`** — a `{ maxInputTokens, headroom?, maxCompactions? }` pre-step guard: when the previous step's model-reported `usage.inputTokens` crosses `maxInputTokens * (headroom ?? 0.9)`, Think compacts in place and feeds the recompacted history into the upcoming step, heading off the provider 400 before it happens. Keys off model-reported usage (every provider reports it), not provider error strings. Bounded per step loop by its own `maxCompactions` (default 1, independent of the reactive `maxRetries` budget).

Also adds a `chat:context:compacted` observability event (`agents`) emitted (once) on both proactive and reactive compaction.

Notes:

- Provider context-overflow errors always surface as in-stream error parts (confirmed against the AI SDK: `streamText` re-enqueues even top-level rejections as `{ type: "error" }` fullStream parts, and `toUIMessageStream` passes them through without throwing), so the in-stream seam catches them on every path; the thrown-error catch path does not need separate wiring.
- Recovery effectiveness depends on the app's compaction config — a no-op compaction cannot rescue an over-budget turn (handled gracefully: terminal, not a loop). A one-time warning fires if `contextOverflow.reactive` is enabled but `classifyChatError` was never overridden.
