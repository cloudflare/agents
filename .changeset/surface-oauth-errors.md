---
"agents": patch
---

Surface MCP OAuth errors to the browser instead of silently swallowing them. Catch thrown errors from handleCallbackRequest so they return proper HTTP responses instead of raw 500s. Show an HTML error page when no errorRedirect or customHandler is configured.
