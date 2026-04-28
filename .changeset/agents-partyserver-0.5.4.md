---
"agents": patch
---

Bump `partyserver` peer dependency to `^0.5.4`. 0.5.4 closes [`cloudflare/partykit#390`](https://github.com/cloudflare/partykit/issues/390): fresh 0.5.x DOs with `compatibility_date` older than 2026-03-15 could lose `this.name` on alarm wake (no `ctx.id.name` propagation in older runtimes, and 0.5.x had stopped writing the `__ps_name` legacy fallback record). The fix is a defensive one-time `__ps_name` write on first fetch — idempotent, restores the safety net pre-0.5.x had. Affects any project on a pre-cutoff `compatibility_date` whose DOs schedule alarms (which includes Think's `_chatRecoveryContinue`).
