---
"agents": patch
---

`ThinkHarness` resolves its tools once per turn attempt, and answers a call to a tool that attempt does not have with a tool error that says it is no longer available, where the turn used to wait for a client that would never answer.
