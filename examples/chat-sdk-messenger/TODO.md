# TODO: Chat SDK Messenger Agents

The first implementation is complete: Chat SDK owns messenger ingress,
`ChatStateAgent` backs Chat SDK state, and `ConversationAgent extends Think`
owns per-thread AI history with Think `chat()` streaming. AI replies are
accepted through managed fibers so webhook retries reuse a stable idempotency
key.

## Streaming Polish

- Decide whether long turns should keep webhook handling open with
  `waitForCompletion: true` or acknowledge immediately and send an async
  follow-up.
- Consider provider-specific streaming affordances beyond text deltas.
- Keep reasoning chunks hidden by default unless a deliberate debug mode exists.
- Decide whether partial responses should end with only an interruption apology,
  a retry button, or provider-specific recovery UI.

## Production Hardening

- Route `ChatIngressAgent` names by tenant, bot, or workspace instead of always
  using `default`.
- Verify provider webhook signatures before choosing an ingress Agent name.
- Add clearer user-facing error messages for model failures, rate limits, and
  unsupported message types.
- Review queue, lock, and debounce settings under high-volume group chats.
- Decide whether terminal `error` or `aborted` managed fibers should support
  user-triggered retry, operator-triggered retry, or manual reconciliation only.
- Decide whether retained managed fibers need an admin/status inspection command
  or should remain an implementation detail.
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
