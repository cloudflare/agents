---
"agents": minor
---

Two new controls for the Pi harness, from Pi 1.5:

- `continue()` starts a run without sending a new message. Use it to try again after a run ended without an answer, for example because the model errored or the run hit its turn limit.
- `defaults.maxTurns` limits how many tool rounds a run can take. A run that reaches it ends without an answer, with reason `turn_limit`.

See [Pi harness](https://developers.cloudflare.com/agents/harnesses/pi/).
