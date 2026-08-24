---
"agents": patch
---

Fall back to no-op tracing when an older Workers runtime exposes tracing without `startActiveSpan`, preventing Agent initialization from failing.
