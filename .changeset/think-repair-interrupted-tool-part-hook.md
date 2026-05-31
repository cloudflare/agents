---
"@cloudflare/think": minor
---

Add a `repairInterruptedToolPart` hook so subclasses can control how an
interrupted tool call is repaired during transcript repair (#1631).

Transcript repair flips a tool call with no settled result to an errored
tool-result (preserving the record and keeping the provider from 400ing). That
is the right default for server tools, but wrong for client-resolved tools like
`ask_user` — a question with no server `execute`, answered by the user's next
message — where the interrupted call _is_ a question and should be preserved as
text so the model sees normal Q→A conversation and compaction keeps the prompt
verbatim. Because repair runs (and persists) before `beforeTurn`, a subclass had
no way to shape this for the current turn.

`repairInterruptedToolPart(part)` defaults to the existing errored-result
behavior and runs during repair, so an override (e.g. converting an interrupted
`ask_user` into a text part carrying the prompt) takes effect on the same turn,
not just the next one.
