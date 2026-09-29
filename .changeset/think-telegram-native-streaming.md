---
"@cloudflare/think": patch
---

Add a `nativeStreaming` option to `telegramMessenger` and forward it to the adapter (#2397). `@chat-adapter/telegram` 4.38 made native draft streaming opt-in, so private-chat replies always posted and edited, with no way to turn drafts back on. `telegramMessenger` also passes `allowUnverifiedWebhooks` when there's no `secretToken`, so `verifyWebhook: false` or a custom `verifyWebhook` no longer throws "secretToken is required in webhook mode" on those adapter versions. Think still refuses a webhook with neither a secret token nor an explicit `verifyWebhook`.
