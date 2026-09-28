---
"@cloudflare/think": minor
---

Add opt-in deferred tool discovery. Set `toolDiscovery = { defer }` and the selected tools stay out of model requests; a `discover_tools` tool lets the model find them by keyword or name, and each one it finds is sent from the next step on, running through the usual validation, hooks, approvals, and authorization. Only tools the turn exposes are discoverable, actions whose static permissions were not granted are left out, and activation is derived from the transcript so resumed turns rebuild the same tool set.
