---
"agents": patch
---

better error handling (based on #65 by @elithrar)

- implement `this.onError` for custom error handling
- log errors from more places
- catch some missed async errors and log them
- mark some methods as actually private
