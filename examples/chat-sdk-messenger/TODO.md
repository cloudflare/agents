# TODO: Chat SDK Messenger Agents

The first implementation is complete: Chat SDK owns messenger ingress,
`ChatSdkStateAgent` backs Chat SDK state, and `ConversationAgent extends Think`
owns per-thread AI history with Think `chat()` streaming. AI replies are
accepted through managed fibers so webhook retries reuse a stable idempotency
key.

## Streaming Polish

- Consider provider-specific streaming affordances beyond text deltas.
- Keep reasoning, tool calls, and tool results visible only in deliberate admin
  debug surfaces, not in messenger output.
- Decide whether partial responses should end with only an interruption apology,
  a retry button, or provider-specific recovery UI.
- Generalize the Telegram long-reply policy into provider-aware delivery helpers
  with documented limits, formatting expansion headroom, and retry semantics.

## Production Hardening

- Route `ChatIngressAgent` names by tenant, bot, or workspace instead of always
  using `default`.
- Put real authentication in front of the admin dashboard before exposing it
  outside local development or trusted deployments.
- Verify provider webhook signatures before choosing an ingress Agent name.
- Add clearer user-facing error messages for model failures, rate limits, and
  unsupported message types.
- Review queue, lock, and debounce settings under high-volume group chats.
- Decide whether terminal `error` or `aborted` managed fibers should support
  user-triggered retry, operator-triggered retry, or manual reconciliation only.
- Add operator retry/reconciliation controls for failed reply jobs now that the
  admin dashboard can inspect retained managed fibers.
- Decide whether to reduce internal subagent/facet calls on hot paths or simply
  document the expected observability noise.

## Chat SDK Tools

- Try read-only `createChatTools` for history/context lookup.
- Do not add write tools until there is an approval UX.
- Map future write approvals to provider-specific UI such as Telegram inline
  buttons.

## Memory Scope

- Start with per-thread Think memory.
- Later consider per-channel memory shared across threads.
- Later consider per-user memory across DMs and groups.

## Provider Portability

- Add a small documented adapter-swap example for another provider.
- Consider a second adapter in the same `Chat()` instance once the Telegram path
  is stable.
- Keep provider-specific rendering in `ChatIngressAgent`, not in
  `ConversationAgent`.

## SDK Extraction Candidates

- Continue hardening the Agents-backed Chat SDK `StateAdapter` in `agents/chat-sdk`
  as more examples validate sharding and TTL behavior.
- Use `src/intelligence/` as the staging area for a future Think-to-Chat-SDK
  streaming bridge once one more provider validates the cancellation,
  empty-response, long-reply, and partial-failure semantics.
- Use `src/provider/telegram.ts` as the reference shape for provider-aware
  delivery policy, then extract only after another adapter validates the split
  between editable first streams, overflow chunks, final-edit no-ops, rate
  limits, and partial delivery failures.
- Keep admin dashboard shape and Telegram-specific operations in examples until
  there is another consumer with the same product requirements.
