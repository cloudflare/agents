---
"agents": patch
---

`ThinkHarness` keeps the output of a model call in flight in a `Streams` instance of its own, apart from any `Streams` your object uses, and moves an interrupted call's stream there at upgrade.
