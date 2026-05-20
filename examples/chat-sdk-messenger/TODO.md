# TODO: Chat SDK Messenger Agents

The first implementation is complete: Chat SDK owns messenger ingress,
`ChatStateAgent` backs Chat SDK state, and `ConversationAgent extends Think`
owns per-thread AI history with Think `chat()` streaming. AI replies are
accepted through managed fibers so webhook retries reuse a stable idempotency
key.

## Streaming Polish

- Consider provider-specific streaming affordances beyond text deltas.
- Keep reasoning chunks hidden by default unless a deliberate debug mode exists.
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

- Move the Agents-backed Chat SDK `StateAdapter` into the SDK once one more
  example or app validates the same sharding and TTL behavior.
- Extract the Think-to-Chat-SDK streaming bridge after the admin UI proves the
  desired cancellation, empty-response, long-reply, and partial-failure
  semantics.
- Extract provider-aware delivery policy once another adapter validates the
  split between editable first streams, overflow chunks, final-edit no-ops, rate
  limits, and partial delivery failures.
- Keep admin dashboard shape and Telegram-specific operations in examples until
  there is another consumer with the same product requirements.
