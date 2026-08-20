---
"agents": patch
---

Validate BrowserConnector tool arguments before execution and reject JSON-stringified Browser Run extraction schemas with an actionable error.

Existing callers that pass values outside the documented schemas must correct them before execution:

- Pass extraction schemas as JSON objects, not JSON strings.
- Pass the string returned in `attachToTarget().sessionId` to `cdp.send`, not the complete attachment result.
