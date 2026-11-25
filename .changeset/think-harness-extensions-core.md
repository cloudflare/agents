---
"agents": patch
---

`ThinkHarness` builds its tools and system prompt through an internal extension core. It no longer calls a tool's `onInputStart`, `onInputDelta` or `onInputAvailable`, and warns once for each tool that has one.
