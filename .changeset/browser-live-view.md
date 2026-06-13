---
"agents": patch
---

Add Browser Run Live View support to the browser tools. The `cdp` connector
gains a `getLiveViewUrl({ targetId?, mode? })` tool that returns a link a human
can open to watch and control a session in real time — the building block for
human-in-the-loop handoffs (login, MFA, CAPTCHA, sensitive input), paired with
the runtime's durable approval pause. `BrowserConnector` also exposes a
host-side `liveView()` helper for surfacing the shared session's Live View URLs
in your own UI; each `BrowserLiveViewTarget` includes the tab's current
`pageUrl` so you can label tabs and filter out blank/internal pages. New
`LiveViewMode`, `BrowserLiveView`, `BrowserLiveViewTarget`, and
`BrowserLiveViewUrl` types are exported from `agents/browser`.
