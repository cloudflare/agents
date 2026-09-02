---
"agents": patch
---

Add intake shaping to `agents/context`.

`shapeMessage` and `shapeHistory` bound what a stored tool result contributes to a model request: a byte cap, a line cap, and a set of host-named fields to drop. Truncation always carries a continuation hint naming the offset to resume from, so an aggressive cap is a detour rather than a dead end. Defaults are pi's 50 KB / 2,000 lines.

It runs on the read path, so storage stays lossless and a limit can change later without having destroyed the bytes. Only tool parts are touched; a long assistant answer passes through untouched, as does an image.

The limits are a function of one message, so a shaped prefix stays byte-identical across turns and prompt caching holds — unlike truncating old history, whose boundary slides every turn.
