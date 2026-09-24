---
"agents": patch
---

Keep oversized tool payloads in AI traces instead of dropping them.

With `storeTools: true`, tool input and output over the 28 KiB trace attribute limit were silently omitted, so any tool call that returned an image (such as a `browser_execute` screenshot) had no recorded result. These payloads are now recorded with base64 data replaced by a size summary like `[base64 image/png data omitted: 184,320 chars, approximately 138,240 bytes]`, keeping the surrounding fields. If a payload is still too large after redaction, the trace records `{"omitted":"tool payload exceeds trace attribute limit","bytes":…}` rather than nothing. Payloads that already fit are recorded unchanged, and the value returned to the caller is never modified.
