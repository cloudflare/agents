# RFC: `AIChatAgent` is first-class + shared chat toolkit

Status: accepted

Related:

- [`rfc-think-multi-session.md`](./rfc-think-multi-session.md) — multi-session pattern (chat children + directory agent), applies equally to `AIChatAgent` children.
- [`think-vs-aichat.md`](./think-vs-aichat.md) — comparison of the two chat base classes.

## Summary

1. `AIChatAgent` is first-class, in production, and getting features.
2. This PR aligns `AIChatAgent` with `Think` where the change is clearly ergonomic: add a `Props` generic, share lifecycle/result types via `agents/chat`, and keep the public `AIChatAgent` surface centered on `ChatMessage` and the existing `messages` field.
3. Shared chat infrastructure belongs in `agents/chat` when both classes benefit. That subpath exists primarily as a sibling-package toolkit today; we can formalize it further later if outside consumers emerge.
4. Multi-session support for `AIChatAgent` needs no new primitive — the sub-agent routing work plus the `Chats` pattern from `rfc-think-multi-session.md` already support it. `examples/multi-ai-chat` is the proof.

## Stance

The public stance is simple:

- `AIChatAgent` is first-class.
- `AIChatAgent` is production-ready.
- `AIChatAgent` continues to receive features, fixes, and examples.

`Think` is not a replacement project in waiting; it is a different chat base class with a different opinionated surface. Both coexist:

- `AIChatAgent` — unopinionated base for users who want full control over the inference pipeline (`onChatMessage(onFinish, options) => Response`), direct ownership of the model call, and a thinner abstraction over the underlying AI SDK.
- `Think` — opinionated base (override `getModel()` / `getTools()` / `configureSession()`, the framework drives the inference loop, Session-backed storage). This is a better fit for users who want higher-level batteries included: Session integration, compaction, context blocks, FTS5 search, etc.

When a capability is obviously shared, it should live in `agents/chat` (or another shared layer) so both classes benefit. When a capability is specific to one model of use, it can live on the class that owns that model.

## Cleanups in this PR (parallel to the Think ones)

### `Props` generic

Before:

```ts
export class AIChatAgent<
  Env extends Cloudflare.Env = Cloudflare.Env,
  State = unknown
> extends Agent<Env, State> { ... }
```

After:

```ts
export class AIChatAgent<
  Env extends Cloudflare.Env = Cloudflare.Env,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>
> extends Agent<Env, State, Props> { ... }
```

Closes the gap we fixed in `Think`. `this.ctx.props` now typed.

### Shared lifecycle types via `agents/chat`

`ChatResponseResult`, `ChatRecoveryContext`, `ChatRecoveryOptions`, `SaveMessagesResult`, `MessageConcurrency` were duplicated in both `@cloudflare/ai-chat` and `@cloudflare/think`. A new `packages/agents/src/chat/lifecycle.ts` owns them; both packages import and re-export from `agents/chat`. Zero behavior change; one place to edit when we tweak a shape.

### Keep `ChatMessage` as the public type name

The public type name here is still `ChatMessage`. That is what users see in docs and in their imports from `@cloudflare/ai-chat`.

Internally, some implementation code now uses `UIMessage`, which is fine — but that's an internal detail, not a public-facing API story. The package keeps exporting:

```ts
export type ChatMessage = UIMessage;
```

### `messages` stays a public field

The field stays exactly what users already expect:

```ts
messages: ChatMessage[] = [];
```

No getter/setter story, no `_messages` backing field, no change in how subclasses reason about the property.

## Multi-session support for `AIChatAgent`

No new API. The `Chats` base class proposed in [`rfc-think-multi-session.md`](./rfc-think-multi-session.md) already declares:

```ts
export abstract class Chats<
  Env extends Cloudflare.Env = Cloudflare.Env,
  ChildClass extends SubAgentClass<Agent<Env>> = SubAgentClass<Agent<Env>>,
  ...
> extends Agent<Env, State, Props> {
  abstract getChildClass(): ChildClass;
  ...
}
```

`ChildClass extends SubAgentClass<Agent<Env>>` — `AIChatAgent` subclasses satisfy this because `AIChatAgent extends Agent`. No special case.

We ship `examples/multi-ai-chat` in this PR as a concrete, hand-rolled preview of the pattern. The example does _not_ use the proposed `Chats` class (it doesn't exist yet), but it does mirror the shape the class will formalize: a parent agent owns the session index and shared memory, per-chat `AIChatAgent` children are spawned via `subAgent()`, and `useAgent({ sub: [...] })` connects directly to each child facet.

That way, when `Chats` lands, the migration is ~10 lines.

## Follow-ups (intentionally out of this PR)

These are structural changes that need real adoption signal before we commit to them. All can land later without breaking anything shipped now.

| Follow-up                                             | Why deferred                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hoist common protocol handling into `agents/chat`     | `_handleChatRequest`, the `onMessage` WS dispatch, `_notifyStreamResuming` / `_handleStreamResumeRequest` / `_handleStreamResumeAck`, the pending-resume-connection tracking, `_reply`-style chunk broadcast — near-identical between `AIChatAgent` and `Think`. A `ChatProtocolBase` helper (mixin or composition) could own these. Big lift, but the payoff is real: one bugfix location, consistent behavior. Want real usage of both classes to stabilize first so we don't encode accidental divergence. |
| Formalize `agents/chat` as a broader external toolkit | Today it's a published subpath export used primarily by sibling packages (`@cloudflare/ai-chat`, `@cloudflare/think`). Keep it stable and versioned, but don't oversell it in user-facing docs yet. If third-party chat base classes emerge, formalize the surface, naming, and docs more aggressively.                                                                                                                                                                                                       |
| `onChatMessage` signature cleanup                     | Current: `onChatMessage(onFinish, options) => Response`. Leaks an AI SDK internal (`StreamTextOnFinishCallback`) and requires constructing a `Response`. A cleaner shape would drop `onFinish` (use `options.onFinish` or a lifecycle hook instead) and return a stream/iterable instead of a Response. Breaking change; only worth doing if we're confident of the final shape.                                                                                                                              |
| `chatRecovery` default                                | `Think` defaults `true`; `AIChatAgent` defaults `false`. Cosmetic but inconsistent. Not breaking to unify; pick a direction during `Think` stabilization.                                                                                                                                                                                                                                                                                                                                                     |
| `sanitizeMessageForPersistence` hook parity           | `AIChatAgent` exposes this override point; `Think` does the equivalent internally. Expose in `Think` too, or document the difference. Minor.                                                                                                                                                                                                                                                                                                                                                                  |
| `StreamTextOnFinishCallback` leaking                  | The `onFinish` callback type is an AI-SDK internal that leaks into `onChatMessage`'s signature. Drop when we revise `onChatMessage`.                                                                                                                                                                                                                                                                                                                                                                          |
| Resumable streams: sync/async consistency             | Both classes have `ResumableStream` now (shared in `agents/chat`). Small API differences in how resume is triggered from the client; consolidate.                                                                                                                                                                                                                                                                                                                                                             |
| Session integration for `AIChatAgent`                 | Explicitly **not** doing this. Users who want Session-backed storage / compaction / context blocks / FTS5 use `Think`. `AIChatAgent` stays on its flat `cf_ai_chat_agent_messages` table.                                                                                                                                                                                                                                                                                                                     |
| Direct deprecation of `AIChatAgent`                   | Not in scope. We only revisit when `Think` is stable and has been used in anger.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ChatMessage` type name                               | Keep `ChatMessage` as the public type name. Internal implementation details can use `UIMessage`, but that is not part of the user-facing story.                                                                                                                                                                                                                                                                                                                                                               |

## Decisions already made

- **Keep the stance clear.** No "deprecated" banners, no migration warnings, no hedged public language. Users who built on `AIChatAgent` are fully supported, and new users should feel confident choosing it when its model of control is what they want.
- **No flag days.** We don't plan to force users off `AIChatAgent` on a timeline. If we ever do deprecate, that gets its own RFC.
- **`examples/multi-ai-chat` ships as a preview of the `Chats` pattern.** The RFC for `Chats` itself is still open; this is a concrete shape to point at while that one lands.
- **`ChatMessage` stays exported and `messages` stays as-is.** The public surface should read naturally, not as a compatibility footnote.

## Open questions

- **Should `messages` be `readonly` or stay mutable?** Decided: stay as-is. Users already understand the field; there is no need to add ceremony around it.
- **Should lifecycle types live in `agents/chat` (current choice) or in a new `agents/chat/lifecycle` subpath?** Sub-subpath feels like overengineering for ~5 types. Rolled into the `agents/chat` barrel.
- **Should `OutgoingMessage` in `types.ts` be promoted into `agents/chat` too?** Probably, but it's the WS wire protocol; a separate cleanup. Left as-is.

## Non-goals

- Rewriting `AIChatAgent` to be a thin wrapper over `Think` (see follow-up table).
- Adding Session integration to `AIChatAgent`.
- Formalizing a chat-base-class factory (`createChatAgent(options)` that produces subclasses).
- Adding a client hook specific to `AIChatAgent` multi-session — `useChats()` (from the `rfc-think-multi-session.md`) is agent-class-agnostic and works for `AIChatAgent` children.
