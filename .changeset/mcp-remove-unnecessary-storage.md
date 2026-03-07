---
"agents": patch
---

Remove unnecessary storage operations in McpAgent:

- Fix redundant `props` read in `onStart`: skip `storage.get("props")` when props are passed directly (only read from storage on hibernation recovery)
- Replace elicitation storage polling with in-memory Promise/resolver: eliminates repeated `storage.get`/`put`/`delete` calls (up to 6 per elicitation) in favor of zero-storage in-memory signaling
