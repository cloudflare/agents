# TODO: Chat SDK Messenger Agents

The first implementation is complete: Chat SDK owns messenger ingress,
`ChatStateAgent` backs Chat SDK state, and `ConversationAgent extends Think`
owns per-thread AI history with Think `chat()` streaming. AI replies are
accepted through managed fibers so webhook retries reuse a stable idempotency
key.

## Streaming Polish

- Improve partial-response and cancellation behavior for long turns.
- Consider provider-specific streaming affordances beyond text deltas.
- Keep reasoning chunks hidden by default unless a deliberate debug mode exists.
- Decide how errors and partial responses should render in chat.

## Production Hardening

- Route `ChatIngressAgent` names by tenant, bot, or workspace instead of always
  using `default`.
- Verify provider webhook signatures before choosing an ingress Agent name.
- Add clearer user-facing error messages for model failures, rate limits, and
  unsupported message types.
- Review queue, lock, and debounce settings under high-volume group chats.
- Revisit whether mid-stream recovery should offer a retry button instead of
  only posting an interruption apology.
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
