---
"@cloudflare/think": patch
---

Rewrite the bot's own unresolved self-mention in messenger events to its readable handle before the model sees it.

When a user @-mentions a Think messenger bot, the triggering message leads with the bot's own mention. Adapters resolve every other user's mention to `@DisplayName` but leave the bot's own as a raw user-id token (for example, Slack's `@U0BD9EYL52S`), which small models can misread as a third party the sender was trying to reach. Think now rewrites that surviving self-mention to `@<userName>` (the bot handle already required on every messenger) in `defaultChatSdkEvent`, reconstructing the `@handle` the sender originally typed.

Adds the exported `resolveSelfMention` helper. Rewriting only applies when the adapter exposes a `botUserId`, so handle-based adapters (for example, Telegram) are unaffected. No new configuration is required.
