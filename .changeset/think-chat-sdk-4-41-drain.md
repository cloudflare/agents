---
"@cloudflare/think": patch
---

Fix messenger recovery with `chat` 4.39 and later, and require `chat` 4.41.1.

`chat` 4.39 changed the private queue method Think uses to answer messages queued behind a reply that a restart interrupted, so on those releases the recovery drain failed and the queued messages waited for the next incoming message. Think now drains through whichever queue shape the installed `chat` release has.

On `chat` 4.39 and later, Think also leaves thread lock renewal to the Chat SDK instead of renewing the lock a second time, and defaults `maxLockLifetimeMs` to 30 minutes (the Chat SDK default is 10 minutes) so a long reply keeps its thread lock. Set `maxLockLifetimeMs` in the messenger `concurrency` setting to change it.
