---
"agents": patch
---

Export shared `agents/tsconfig` and `agents/vite` so examples and internal projects are self-contained. The `agents/vite` plugin handles TC39 decorator transforms for `@callable()` until Oxc lands native support.
