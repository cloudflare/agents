---
"agents": minor
---

Support the next Pi release. Pi tools now park with `{ kind: "sleep", signals, until }` instead of `{ sleep: { ... } }`, and a signal's state is `{ kind: "value", value }` or `{ kind: "expired" }`. A tool that still returns the old shape compiles but ends with an empty result, so update parking tools when you upgrade. See [Tools that wait](https://developers.cloudflare.com/agents/harnesses/pi/#tools-that-wait).
