---
"agents": minor
"partyserver": minor
---

Vendor PartyServer into the Agents repository and add a generic Durable Object component lifecycle for startup, request interception, alarms, and explicit disposal. Re-export the substrate from `agents/lifecycle` while preserving existing `Agent` and `partyserver` exports and package identity.

Named Durable Objects now use native `ctx.id.name` without writing a redundant `__ps_name` copy. Legacy reads, raw-ID bootstrap, and mixed-version wire paths remain supported.
