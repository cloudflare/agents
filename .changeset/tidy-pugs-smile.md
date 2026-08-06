---
"agents": patch
---

Stop a resumed turn from showing the model's reasoning twice.

On reconnect the server hydrates the persisted turn and then replays it from
its first chunk. The hook collapses a hydrated part that survives the race with
its replayed rebuild, but it only did that for `text` parts, so a hydrated
reasoning block and its replayed copy both stayed in the message — the thinking
block appeared again on every reconnect. Reasoning is rebuilt from its first
chunk and carries the accumulated string exactly as text does, so it now uses
the same rule.
