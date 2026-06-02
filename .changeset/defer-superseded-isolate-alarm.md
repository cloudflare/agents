---
"agents": patch
---

Recover one-shot scheduled work (alarms) killed by a `"This script has been upgraded…"` deploy/code-update, not just `"Durable Object reset because its code was updated."`.

`_executeScheduleCallback` only re-runs a one-shot schedule row after a superseded-isolate error if the error matched `/reset because its code was updated/i`. The platform also surfaces the same failure class as `"This script has been upgraded. Please send a new request to connect to the new version."` (a stub/connection to a superseded script), which fell through to the swallow-and-delete branch — the one-shot row was deleted and the work abandoned. For a queued submission this orphaned the pending row with no driver (no alarm, no retry) until something unrelated woke the Durable Object, leaving the user on an indefinite spinner.

The superseded-isolate matcher now recognizes both messages, so either causes the row to be preserved and re-run on the fresh isolate under the at-least-once alarm guarantee. `"Network connection lost."` is intentionally not included (it is a connection error that may succeed on in-process retry, not an isolate replacement).
