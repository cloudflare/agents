---
"@cloudflare/think": patch
---

Support `experimental_transform` on `TurnConfig`. The transform(s) returned from `beforeTurn` are now forwarded to `streamText` in the inference loop, so callers can inspect or rewrite the stream — for example, detecting tool results that carry `{ content, sources }` and enqueuing additional `source` parts via the transform's controller. Accepts a single transform or an array applied in order. Closes #1714.
