---
"agents": patch
---

`useAgentChat` now lets the server's message snapshot replace an observed (cross-tab or resumed) assistant message when the live copy's text no longer extends the server's copy. An interleaved or duplicated observed stream previously overrode every clean snapshot, including the final one, so the scrambled text stayed until a page reload.
