---
"agents": patch
---

`Streams` rechecks that the v1 chunk table still exists before using it. Two Streams instances on one object, such as a host's own and the one `ThinkHarness` keeps, each remembered the table separately, so after one folded the last v1 rows and dropped the table the other failed its next append with `no such table`.
