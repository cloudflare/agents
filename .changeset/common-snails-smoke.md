---
"agents": patch
---

Fixes #2013 by correctly invoking `controller.error` during a websocket closure before receiving a `done: true` frame. This previously led to the AI SDK's `useChat` interpreting this as a normal completion. Tests have also been updated accordingly.
