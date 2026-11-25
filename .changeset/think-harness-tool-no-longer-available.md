---
"agents": patch
---

`ThinkHarness` resolves its tools once per turn attempt. A call cut off before it ran whose tool that attempt no longer has is answered with a tool error that says it is no longer available, where the turn used to wait for a client that would never answer.
