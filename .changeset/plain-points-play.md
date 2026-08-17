---
"agents": minor
---

Add connection-scoped Kitesurf support to Browser Tools through the `browser: "kitesurf"` session option. Unsupported durable session, Live View, recording, pause/resume, and Kitesurf-backed Quick Action surfaces remain unavailable.

Existing Browser Tools users should note:

- Large base64 values returned outside the canonical `{ type: "browser_screenshot", mediaType, data }` shape are now redacted. Return screenshots in that shape or store binary output elsewhere.
- TanStack browser tools have one output channel, so screenshot output is reduced to the compact model-facing summary rather than returning raw base64 data.
