---
"agents": patch
---

Sessions store a message or attachment chunk of up to 1.9 MB in one row (was 1.5 MiB), so a large message takes fewer rows. Messages already stored read back unchanged.
