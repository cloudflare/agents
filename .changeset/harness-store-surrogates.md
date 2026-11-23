---
"agents": patch
---

The harness store no longer corrupts a log entry whose JSON is over 256 K characters and has an emoji (or another character outside the Basic Multilingual Plane) on a chunk boundary.
