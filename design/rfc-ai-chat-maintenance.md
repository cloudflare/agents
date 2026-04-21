# RFC: `AIChatAgent` maintenance + shared chat toolkit

Status: proposed

Related:

- [`rfc-think-multi-session.md`](./rfc-think-multi-session.md) — multi-session pattern (chat children + directory agent), applies equally to `AIChatAgent` children.
- [`think-vs-aichat.md`](./think-vs-aichat.md) — comparison of the two chat base classes.

## Summary

1. `AIChatAgent` is **not** going away. It stays first-class and fully supported until `Think` is stable enough to be the clear default — which will take a while.
2. Small ergonomic alignments with `Think` land now (parallel to what we already did for Think): add a `Props` generic, share lifecycle types via `agents/chat`, standardize on `UIMessage`, make `messages` a readonly getter. These are mechanical and don't change behavior.
3. **Future structural work** is staged in follow-ups: hoist duplicated protocol/lifecycle logic into `agents/chat` as a shared toolkit, and — if adoption justifies it — promote `agents/chat` to a first-class public API so third parties can build their own chat base classes.
4. Multi-session support for `AIChatAgent` needs no new API — the `Chats` pattern from `rfc-think-multi-session.md` already supports any `Agent` subclass as the chat child. We ship `examples/multi-ai-chat` as a concrete preview of that pattern using `AIChatAgent`.

## Stance

While `Think` is still stabilizing, both classes coexist:

- `AIChatAgent` — unopinionated base for users who want full control over the inference pipeline (`onChatMessage(onFinish, options) => Response`). Bug fixes, safety improvements, and cross-class alignments land as needed. New _features_ land in `agents/chat` where they can benefit both classes.
- `Think` — opinionated base (override `getModel()` / `getTools()` / `configureSession()`, the framework drives the inference loop, Session-backed storage). This is where new chat features live: Session integration, compaction, context blocks, FTS5 search, sub-agent composition via RPC, etc.

When `Think` has been exercised in real-world use for a release or two and feels like the right default, we revisit. Deprecation is not on the table in this RFC.

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

### Standardize on `UIMessage`

`AIChatAgent` previously imported `UIMessage as ChatMessage` and used `ChatMessage` throughout. `Think` always used `UIMessage`. Naming divergence across sibling packages adds cognitive load for no benefit. `AIChatAgent` now uses `UIMessage` everywhere. The protocol-message types in `types.ts` still have `ChatMessage` as a _generic parameter name_ in the `OutgoingMessage<ChatMessage extends UIMessage = UIMessage>` / `IncomingMessage<…>` signatures — that's a local identifier, not an imported alias, and staying stable there avoids a larger breaking change for users of those types.

### `messages` is a readonly getter

Before: `messages: UIMessage[]` — a public mutable field, mutated in place (or reassigned) throughout the class and subclasses.

After:

```ts
get messages(): readonly UIMessage[] {
  return this._messages;
}
protected _messages: UIMessage[] = [];
```

Subclasses can't accidentally `push` into the array or replace it. Internal mutation still happens through `this._messages`. This is a small TypeScript-level breaking change: subclasses that assigned to `this.messages` will need to move writes through official methods (`saveMessages`, `persistMessages`) or migrate to `_messages` if they have a legitimate reason to touch internal state.

`_messagesForClientSync()`, the `reconcileMessages` helpers, and the protocol `OutgoingMessage` shape all accept `readonly UIMessage[]` — the readonly-ness ripples through without requiring copies on hot paths.

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

We ship `examples/multi-ai-chat` in this PR as a concrete, hand-rolled preview of the pattern. The example does _not_ use the proposed `Chats` class (it doesn't exist yet), but it does mirror the shape the class will formalize: a parent agent owns the session index and shared memory, per-chat `AIChatAgent` children are spawned via `subAgent()`, and `useAgent()` connects directly to each child.

That way, when `Chats` lands, the migration is ~10 lines.

## Follow-ups (intentionally out of this PR)

These are structural changes that need real adoption signal before we commit to them. All can land later without breaking anything shipped now.

| Follow-up                                         | Why deferred                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hoist common protocol handling into `agents/chat` | `_handleChatRequest`, the `onMessage` WS dispatch, `_notifyStreamResuming` / `_handleStreamResumeRequest` / `_handleStreamResumeAck`, the pending-resume-connection tracking, `_reply`-style chunk broadcast — near-identical between `AIChatAgent` and `Think`. A `ChatProtocolBase` helper (mixin or composition) could own these. Big lift, but the payoff is real: one bugfix location, consistent behavior. Want real usage of both classes to stabilize first so we don't encode accidental divergence. |
| Promote `agents/chat` to public first-class API   | Today it's a subpath export with a "chat toolkit you probably don't need directly" vibe. If third-party chat base classes emerge (we'd expect a handful), formalize the surface, version discipline, docs.                                                                                                                                                                                                                                                                                                    |
| `onChatMessage` signature cleanup                 | Current: `onChatMessage(onFinish, options) => Response`. Leaks an AI SDK internal (`StreamTextOnFinishCallback`) and requires constructing a `Response`. A cleaner shape would drop `onFinish` (use `options.onFinish` or a lifecycle hook instead) and return a stream/iterable instead of a Response. Breaking change; only worth doing if we're confident of the final shape.                                                                                                                              |
| `chatRecovery` default                            | `Think` defaults `true`; `AIChatAgent` defaults `false`. Cosmetic but inconsistent. Not breaking to unify; pick a direction during `Think` stabilization.                                                                                                                                                                                                                                                                                                                                                     |
| `sanitizeMessageForPersistence` hook parity       | `AIChatAgent` exposes this override point; `Think` does the equivalent internally. Expose in `Think` too, or document the difference. Minor.                                                                                                                                                                                                                                                                                                                                                                  |
| `StreamTextOnFinishCallback` leaking              | The `onFinish` callback type is an AI-SDK internal that leaks into `onChatMessage`'s signature. Drop when we revise `onChatMessage`.                                                                                                                                                                                                                                                                                                                                                                          |
| Resumable streams: sync/async consistency         | Both classes have `ResumableStream` now (shared in `agents/chat`). Small API differences in how resume is triggered from the client; consolidate.                                                                                                                                                                                                                                                                                                                                                             |
| Session integration for `AIChatAgent`             | Explicitly **not** doing this. Users who want Session-backed storage / compaction / context blocks / FTS5 use `Think`. `AIChatAgent` stays on its flat `cf_ai_chat_agent_messages` table.                                                                                                                                                                                                                                                                                                                     |
| Direct deprecation of `AIChatAgent`               | Not in scope. We only revisit when `Think` is stable and has been used in anger.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ChatMessage` exported type alias                 | Stays in `types.ts` as a generic parameter name (`OutgoingMessage<ChatMessage extends UIMessage = UIMessage>`). Users who import `ChatMessage` from `@cloudflare/ai-chat` see it removed in this PR; they should switch to `UIMessage` from `"ai"`.                                                                                                                                                                                                                                                           |

## Decisions already made

- **Keep the stance ambiguity small.** No "deprecated" banners, no migration warnings, no LSP hints. Users who built on `AIChatAgent` are fully supported. Users reading docs see `Think` recommended for new projects once it's stable.
- **No flag days.** We don't plan to force users off `AIChatAgent` on a timeline. If we ever do deprecate, that gets its own RFC.
- **`examples/multi-ai-chat` ships as a preview of the `Chats` pattern.** The RFC for `Chats` itself is still open; this is a concrete shape to point at while that one lands.

## Open questions

- **Should `messages` be `readonly` or stay mutable?** We picked readonly. The ergonomic cost is low (5 call sites plus a shared reconciler signature bumped to `readonly UIMessage[]`). Some users may have subclasses that reassigned `this.messages` — they'll hit a type error and need a one-line fix. Acceptable pre-1.0.
- **Should lifecycle types live in `agents/chat` (current choice) or in a new `agents/chat/lifecycle` subpath?** Sub-subpath feels like overengineering for ~5 types. Rolled into the `agents/chat` barrel.
- **Should `OutgoingMessage` in `types.ts` be promoted into `agents/chat` too?** Probably, but it's the WS wire protocol; a separate cleanup. Left as-is.

## Non-goals

- Rewriting `AIChatAgent` to be a thin wrapper over `Think` (see follow-up table).
- Adding Session integration to `AIChatAgent`.
- Formalizing a chat-base-class factory (`createChatAgent(options)` that produces subclasses).
- Adding a client hook specific to `AIChatAgent` multi-session — `useChats()` (from the `rfc-think-multi-session.md`) is agent-class-agnostic and works for `AIChatAgent` children.
