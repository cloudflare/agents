# RFC: Think chained continuation turns

Status: proposed

Related:

- [`think.md`](./think.md) - Think's turn, streaming, session, and recovery model.
- [`think-durable-submissions.md`](./think-durable-submissions.md) - durable programmatic turn acceptance.
- [`docs/think/sub-agents.md`](../docs/think/sub-agents.md) - current `saveMessages()` and `continueLastTurn()` user surface.
- [`docs/think/lifecycle-hooks.md`](../docs/think/lifecycle-hooks.md) - current Think hook surface.
- [cloudflare/agents#1386](https://github.com/cloudflare/agents/issues/1386) - motivating request for multi-phase chained turns.

## Summary

Add first-class support for chained continuation turns in `Think`: after a model
turn completes, Think can decide to run another full `streamText` turn against
custom in-memory model messages, without persisting a synthetic user message.
Each continuation turn still uses Think's normal streaming, persistence,
resumable stream, abort, and recovery machinery. Only the prompt used to trigger
the next phase remains synthetic and in-memory.

This is for long-running coding, research, and planning agents that need to
continue after a per-turn step or token budget is exhausted. The model should
keep working, but the user's transcript should not fill with framework-authored
messages such as `[auto-continue]`.

The main public shape is a hook:

```typescript
protected prepareContinuationTurn?(
  ctx: ContinuationTurnContext
): ContinuationTurnDecision | null | Promise<ContinuationTurnDecision | null>;
```

The hook prepares the next phase or returns `null` to end the chain. A
lower-level `runContinuationTurn()` helper can exist for advanced internal and
subclass use, but the framework-owned hook loop is the recommended path because
it can enforce phase caps, preserve ordering, and avoid re-entrant turn-queue
traps.

## Problem

`Think` already has most of the mechanics needed for continuation:

- `continueLastTurn()` runs another assistant turn without injecting a new user
  message.
- `beforeTurn()` can override `TurnConfig.messages`, so in-memory model context
  substitution is already possible.
- auto-continuation after client tool results already persists and broadcasts a
  second assistant response without a synthetic user message.
- durable submissions and chat recovery already route through the same turn,
  stream, abort, and persistence infrastructure.

But none of these provide a complete user-facing pattern for multi-phase
continuation after budget exhaustion.

The gaps are:

- `onChatResponse()` does not expose enough completion data to reliably decide
  whether the model stopped naturally or exhausted a per-turn step/token budget.
- Users can approximate chaining by calling `saveMessages()` from
  `onChatResponse()`, but that persists a synthetic user message and asks users
  to reason about turn-queue timing.
- `continueLastTurn()` cannot currently accept explicit in-memory
  `ModelMessage[]` for compacted continuation prompts.
- There is no built-in phase cap, so every app has to implement its own loop
  guard and failure behavior.
- The subtle parts are framework concerns: streaming over WebSocket/SSE,
  assistant-message persistence, resumable-stream metadata, abort propagation,
  recovery, and interaction with client tools.

The issue is not that Think lacks a way to run another turn. It lacks a narrow
API that makes this pattern safe, discoverable, and hard to accidentally persist
as user-visible transcript noise.

## Goals

- Run another full model turn after the previous one completes, without
  persisting any synthetic user message used to steer the continuation.
- Persist and broadcast each assistant response exactly like any other Think
  turn.
- Let subclasses rebuild the in-memory `ModelMessage[]` for each phase.
- Expose enough turn-completion metadata to decide whether continuation is
  appropriate.
- Enforce a framework-level continuation phase cap.
- Reuse Think's existing turn queue, resumable stream, abort registry, chat
  recovery, client-tool schemas, request body persistence, tool wrapping, and
  lifecycle hooks.
- Keep the first API small enough for common agentic-loop use without exposing
  raw `streamText()` streams.

## Non-goals

- Do not replace `saveMessages()` or durable `submitMessages()`. Those remain
  the APIs for injecting concrete user/server messages into the transcript.
- Do not append continuation output into the previous assistant message. Each
  phase produces a separate assistant message, matching current
  `continueLastTurn()` behavior.
- Do not make synthetic continuation prompts visible to clients or persisted
  message history.
- Do not expose raw `StreamableResult` as the primary public API. Think owns
  streaming and persistence.
- Do not add the same hook surface to `AIChatAgent` in this RFC.
  `AIChatAgent` deliberately lets subclasses own `onChatMessage()` and the
  model-call loop, so a framework-owned continuation hook would either be too
  weak to help or would pull `AIChatAgent` toward Think's opinionated design.
- Do not solve arbitrary workflow orchestration. Workflows and durable
  submissions remain the right tools for long-running business processes and
  external side effects.

## Proposal

### Turn completion metadata

Extend the result shape passed to response/continuation hooks so a subclass can
make continuation decisions without correlating separate hook logs.

```typescript
export type ChatResponseResult = {
  message: UIMessage;
  requestId: string;
  continuation: boolean;
  status: "completed" | "error" | "aborted";
  error?: string;

  /**
   * Framework-normalized reason the turn stopped. This is broader than the
   * provider finish reason and should be the first field subclasses inspect
   * when deciding whether to continue.
   */
  stopReason?:
    | "model-stop"
    | "step-limit"
    | "output-limit"
    | "aborted"
    | "error"
    | "unknown";

  /**
   * AI SDK finish reason for the final model step when available.
   * Examples include "stop", "tool-calls", "length", or provider-specific
   * values surfaced by the AI SDK.
   */
  finishReason?: string;

  /** Aggregate token usage for the turn when available. */
  usage?: ChatUsage;

  /** Number of model steps completed in this turn when known. */
  stepCount?: number;

  /** Turn limits and whether Think detected that they were exhausted. */
  limits?: {
    maxSteps?: number;
    hitMaxSteps?: boolean;
    maxOutputTokens?: number;
    hitMaxOutputTokens?: boolean;
  };
};

export type ChatUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
};
```

`stopReason`, `limits`, `finishReason`, `usage`, and `stepCount` should be
best-effort, but `stopReason: "step-limit"` / `limits.hitMaxSteps` is the
preferred signal for max-step continuation. `ChatUsage` intentionally mirrors
the stable fields Think already snapshots from the AI SDK step usage object for
extension hooks. `usage` is the sum of known step usage for this turn; provider-
specific accounting can stay in `providerMetadata` on step hooks until there is
a clear need to aggregate it at the chat-response level. Existing subclasses
that only care about `message`, `requestId`, `continuation`, and `status` keep
working.

### Continuation hook

Add a hook that runs after a phase's assistant message has been persisted and
broadcast, but before the framework considers the full chained turn complete.

```typescript
export type ContinuationTurnContext = {
  /** Zero for the initial turn, one for the first continuation, etc. */
  turnIndex: number;
  /** Result from the phase that just completed. */
  result: ChatResponseResult;
  /** Current persisted UI history after the just-finished assistant message. */
  history: UIMessage[];
  /**
   * Pre-beforeTurn model messages Think would send for the next continuation
   * if this hook returned the default configuration.
   */
  defaultMessages: ModelMessage[];
  /** Custom body associated with the original turn, if any. */
  body?: Record<string, unknown>;
};

export type ContinuationTurnDecision = TurnConfig & {
  /** Optional body override for the next phase. */
  body?: Record<string, unknown>;
};
```

Returning `null` ends the chain. Returning any object schedules the next phase
inside the same framework-owned continuation loop. An empty object (`{}`)
continues with `defaultMessages` and the default turn configuration.

`body` is request metadata for the continuation turn. It is not sent directly to
the model, but it is exposed to Think hooks as `TurnContext.body` for subclasses
that route models, tools, or behavior from custom request fields.

The returned decision becomes the initial `TurnConfig` for the next
continuation phase. Think then runs the normal `beforeTurn()` and extension
`beforeTurn` pipeline for that phase with `continuation: true`, so global
per-turn policy still applies and can inspect or override the prepared
continuation config.

Example:

```typescript
class CodingAgent extends Think<Env> {
  override maxContinuationPhases = 4;

  override async prepareContinuationTurn(ctx: ContinuationTurnContext) {
    if (ctx.result.status !== "completed") return null;
    if (ctx.result.stopReason !== "step-limit") return null;

    const messages = await this.compactForContinuation({
      history: ctx.history,
      defaultMessages: ctx.defaultMessages,
      turnIndex: ctx.turnIndex
    });

    messages.push({
      role: "user",
      content:
        "[auto-continue] Continue the task. Do not repeat completed exploration."
    });

    return {
      messages,
      maxSteps: 10
    };
  }
}
```

The synthetic `[auto-continue]` instruction above is sent only to the model. It
is not appended to Session and does not appear in client message history.

The exact continuation predicate is application-specific. Most budget-driven
agents should start with `stopReason` / `limits`; others may also inspect
`finishReason`, step count, token usage, or explicit model markers. The important
part is that the hook receives enough result metadata to make that decision
without reconstructing it from unrelated lifecycle logs.

### Phase cap

Add an instance property:

```typescript
maxContinuationPhases = 0;
```

`0` means no chained continuation by default. If set to `4`, Think may run up to
four continuation phases after the initial turn, for five total model calls in
the chain.

Use `maxContinuationPhases` rather than a default of `1` to avoid the ambiguity
where "one phase" could mean either the initial turn or one continuation.

Think should not call `prepareContinuationTurn()` after the cap is exhausted.
For `maxContinuationPhases = 4`, the hook may schedule continuations after turn
indexes `0`, `1`, `2`, and `3`. After turn index `4` completes, the chain ends
without another hook call.

### Advanced helper

Add a protected helper for advanced users and internal recovery/tool flows:

```typescript
export type ContinuationTurnOptions = TurnConfig & {
  body?: Record<string, unknown>;
  signal?: AbortSignal;
};

protected async runContinuationTurn(
  options?: ContinuationTurnOptions
): Promise<SaveMessagesResult>;
```

Most subclasses should use `prepareContinuationTurn()` instead. The helper is an
escape hatch for explicit framework-managed continuations outside the automatic
chain. It is not required for normal chained-turn users and should not be the
primary v1 documentation path.

The name distinction should be intentional:

| API                     | Meaning                                                                   | Common use                                                                            |
| ----------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `continueLastTurn()`    | Continue from the current persisted transcript exactly as-is.             | "Generate more", chat recovery, simple no-user-message continuation.                  |
| `runContinuationTurn()` | Run a continuation phase, optionally replacing the model input in memory. | Chained turns with compaction, synthetic continuation instructions, per-phase config. |

`continueLastTurn()` is the convenience API. It answers "continue from the last
assistant message in Session." It should not accept custom `ModelMessage[]`,
because that would make "last turn" ambiguous.

`runContinuationTurn()` is the advanced phase API. It answers "run another
Think-owned continuation turn, but let me override what the model sees." If
`messages` is omitted, it falls back to the same persisted-history behavior as
`continueLastTurn()`.

If `messages` is provided, Think uses those in-memory model messages for the
next call, but still persists only the assistant output.

`continueLastTurn()` can remain as a compatibility wrapper around
`runContinuationTurn({ body, signal })`, but docs should present it as the
simple API and `runContinuationTurn()` as the escape hatch for continuation
frameworks.

### Execution model

All entry paths continue to converge on the same inference loop:

1. Persist incoming user/server messages when the entry path has concrete
   messages to persist.
2. Run turn index 0 through `_runInferenceLoop()`.
3. Stream chunks to clients and resumable storage.
4. Persist the assistant message.
5. Build `ChatResponseResult` with completion metadata.
6. Call `prepareContinuationTurn()` if the result is eligible and the phase cap
   has not been reached.
7. Fire and await `onChatResponse()` for the persisted assistant message,
   preserving existing Think lifecycle semantics.
8. If `prepareContinuationTurn()` returned a decision, run another full
   inference phase using that decision as the initial `TurnConfig`.
9. Repeat until the hook returns `null`, the phase cap is reached, the turn is
   aborted, or an error occurs.

`prepareContinuationTurn()` is deliberately before `onChatResponse()` in the
control flow, so the continuation decision does not depend on response-hook side
effects. Think should still await `onChatResponse()` before starting the next
phase, matching the current lifecycle contract that async response hooks
complete before subsequent framework-driven turns begin. Subclasses with
latency-sensitive analytics should dispatch that work from `onChatResponse()`
instead of awaiting it.

Each phase should still fire observational hooks:

- `beforeTurn()` sees `continuation: true` for continuation phases.
- `beforeStep()`, `beforeToolCall()`, `afterToolCall()`, `onStepFinish()`, and
  `onChunk()` fire normally for each phase.
- `onChatResponse()` fires for each persisted assistant message.

`prepareContinuationTurn()` is the only hook that can directly schedule another
phase without going back through `saveMessages()`.

### Interaction with `onChatResponse()`

`onChatResponse()` remains observational and reactive. It is still useful for
analytics, logging, queue draining, and server-driven follow-ups that should
persist visible messages.

Chained continuation should not require users to call `saveMessages()` or
`continueLastTurn()` from inside `onChatResponse()`. That pattern is easy to get
wrong because it crosses the turn queue while a response hook is running, and it
does not naturally support hidden in-memory continuation prompts.

The framework-owned `prepareContinuationTurn()` loop gives Think one place to
enforce ordering, phase caps, abort behavior, and recovery policy.

`onChatResponse()` may still call `saveMessages()` for visible follow-up work,
but that is separate from chained continuation. Chained phases should be driven
only by `prepareContinuationTurn()`.

If `onChatResponse()` enqueues visible follow-up work after
`prepareContinuationTurn()` has already prepared a continuation, the prepared
continuation should run first. Visible follow-ups from `onChatResponse()` enter
the normal turn queue after the current chained phase has yielded; they should
not interleave ahead of a framework-owned continuation that was already chosen
from the completed phase.

### Recovery

Continuation phases should use the same `runFiber` wrapping as existing chat
turns when `chatRecovery` is enabled.

Recovery only needs to preserve user-visible state and enough framework state to
resume safely:

- assistant chunks and persisted messages remain the durable source of truth
- synthetic continuation prompts are not persisted as chat messages
- if a continuation phase is interrupted after assistant chunks are written,
  current chat recovery behavior can persist the partial assistant message and
  schedule `runContinuationTurn()`
- if an app needs deterministic replay of a custom compaction decision after
  eviction, it should make that decision derivable from persisted history,
  `stash()`, or subclass state

The first implementation should avoid promising exact replay of arbitrary
in-memory continuation prompts across isolate eviction unless the subclass
persists the needed state itself.

### Client tools

Continuation phases should inherit the same client tool schemas and request body
that current auto-continuation uses, unless a `ContinuationTurnDecision.body`
override is returned.

If a continuation phase produces client tool calls, the existing client-tool
result flow applies. Framework-driven chained continuation should not bypass
human approval or client execution requirements.

### Durable submissions

For durable `submitMessages()` work, the submission should remain `running`
until the continuation chain ends. Marking the submission `completed` after only
the initial phase would tell callers that accepted work is done while Think is
still producing assistant messages caused by the same submission.

### Relationship to AIChatAgent

This RFC is intentionally scoped to `Think`. The proposed hook depends on Think
owning turn assembly, the `streamText()` call, `beforeTurn()` / `beforeStep()`,
tool wrapping, continuation state, and assistant-message persistence. That is
what lets the framework prepare another phase without exposing raw streams or
persisting synthetic user messages.

`AIChatAgent` has a different contract: subclasses own `onChatMessage()` and can
call the AI SDK however they want. Adding `prepareContinuationTurn()` there would
not have enough control to guarantee the same behavior unless `AIChatAgent`
started owning more of the inference loop. That would blur the distinction
between the two chat base classes.

If `AIChatAgent` users need chained turns, the first step should be a documented
pattern or helper for their user-owned `onChatMessage()` implementation. Shared
metadata types such as `ChatResponseResult`, `ChatUsage`, or low-level
`agents/chat` utilities can still benefit both classes, but framework-owned
chained continuation belongs in Think unless the shared chat layer grows a
stronger inference-loop abstraction later.

### Implementation notes

`stopReason` and `limits` should be derived by Think, not guessed by
subclasses:

- `limits.maxSteps` is the effective max steps for the turn after
  `prepareContinuationTurn()`, `beforeTurn()`, and extension overrides.
- `limits.hitMaxSteps` is true when the completed step count reaches that
  effective max and the model did not otherwise stop naturally.
- `stopReason: "step-limit"` is the normalized signal for that case.
- `limits.maxOutputTokens` is the effective output-token cap when one was
  configured.
- `limits.hitMaxOutputTokens` / `stopReason: "output-limit"` should be set when
  the AI SDK/provider finish reason indicates length or output-token exhaustion.
- If Think cannot confidently classify the stop, it should leave limit booleans
  unset and use `stopReason: "unknown"` rather than inventing certainty.

The chained-loop implementation should keep the turn queue as the serialization
boundary. Continuation phases chosen by `prepareContinuationTurn()` are part of
the current framework-owned chain; visible follow-up work enqueued from
`onChatResponse()` is normal queued work and runs after the prepared
continuation phase.

## Alternatives

### Keep using `onChatResponse()` plus `saveMessages()`

Rejected as the primary design.

This is good for visible server-driven follow-ups, but it persists the synthetic
continuation instruction as a user message. It also leaves phase caps, abort
propagation, compaction, and re-entrant queue timing to every application.

### Keep using `onChatResponse()` plus `continueLastTurn()`

Partially useful, but incomplete.

It avoids persisting a synthetic user message, but it does not let the caller
replace the model messages with a compacted continuation prompt. Users still
need side channels to decide whether the previous turn exhausted a budget, and
the re-entrant scheduling concern remains.

### Expose raw `StreamableResult` from `runContinuationTurn()`

Rejected.

Returning a raw stream would make callers responsible for exactly the machinery
Think exists to own: chunk broadcast, resumable storage, accumulator state,
assistant-message persistence, response hooks, errors, aborts, and recovery.
The public helper should return `SaveMessagesResult` and keep streaming internal.

### Add `persist: false` to `saveMessages()`

Rejected for this use case.

`saveMessages()` means "save these messages and run a turn." Adding a
non-persisting mode would make the name misleading and create a confusing split
where some messages in the argument become durable and some do not. Hidden
continuation prompts are better modeled as model-call input, not as unsaved
`UIMessage`s.

### Implement only a helper, no hook

Rejected as incomplete.

A helper is useful for advanced code, recovery, and compatibility, but the
recurring pattern is a loop with a stop condition, custom compaction, phase caps,
and error handling. That loop should be framework-owned so applications do not
all rediscover the same edge cases.

## Future considerations

- Add an explicit hook or event when a chain stops because
  `maxContinuationPhases` was exhausted. The first version can simply end the
  chain after the final assistant message; observability can come later if users
  need a dedicated signal.

## Decision

Pending.

The proposed direction is to add framework-owned chained continuation to Think,
centered on `prepareContinuationTurn()`, with `runContinuationTurn()` as the
lower-level helper. The implementation should be incremental:

1. Capture final turn metadata (`finishReason`, usage, step count) while
   streaming.
2. Add `runContinuationTurn({ messages, maxSteps, body, signal })` and refactor
   `continueLastTurn()` through it.
3. Add `maxContinuationPhases` and `prepareContinuationTurn()`.
4. Drive the chained loop from the normal Think turn path.
5. Add tests for hidden synthetic prompts, phase caps, abort, recovery, client
   tools, and `onChatResponse()` ordering.
