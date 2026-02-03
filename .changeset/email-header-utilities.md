---
"agents": patch
---

Add email header parsing utilities for working with postal-mime

New utilities to simplify working with email headers from postal-mime:

- `parseEmailHeaders(headers)` - Converts postal-mime headers array to a simple `Record<string, string>` object
- `getEmailHeader(headers, name)` - Gets a specific header value (case-insensitive)
- `hasEmailHeader(headers, name)` - Checks if a header exists (case-insensitive)
- `hasAnyEmailHeader(headers, names)` - Checks if any of the specified headers exist
- `getAllEmailHeaders(headers, name)` - Gets all values for headers that appear multiple times (e.g., `Received`)
- `isAutoReplyEmail(headers)` - Detects auto-reply emails based on standard headers (RFC 3834)

Example usage:

```typescript
import { parseEmailHeaders, isAutoReplyEmail } from "agents";
import PostalMime from "postal-mime";

async onEmail(email: AgentEmail) {
  const raw = await email.getRaw();
  const parsed = await PostalMime.parse(raw);

  // Convert headers to simple object
  const headers = parseEmailHeaders(parsed.headers);
  console.log(headers["content-type"]);

  // Detect and skip auto-reply emails
  if (isAutoReplyEmail(parsed.headers)) {
    console.log("Skipping auto-reply");
    return;
  }

  // Process the email...
}
```
