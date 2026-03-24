---
"agents": patch
---

Fix alarm handler resilience: move `JSON.parse(row.payload)` inside try/catch and guard warning emission so a single failure cannot break processing of remaining schedule rows.
