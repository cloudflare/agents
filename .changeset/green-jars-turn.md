---
"agents": minor
---

Add hook-style runtime context lifecycle support in `agents` with `onContextStart` / `onContextEnd`, typed `this.context`, and context propagation via `getCurrentAgent().context` and `getCurrentContext()`.
