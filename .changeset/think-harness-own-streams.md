---
"agents": patch
---

`ThinkHarness` keeps the output of a model call in flight in a `Streams` instance of its own, apart from any `Streams` your object uses, and moves a stream an earlier version kept in the shared tables there when it next reads it.
