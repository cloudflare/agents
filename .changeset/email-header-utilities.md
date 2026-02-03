---
"agents": patch
---

Add `isAutoReplyEmail()` utility to detect auto-reply emails

Detects auto-reply emails based on standard RFC 3834 headers (`Auto-Submitted`, `X-Auto-Response-Suppress`, `Precedence`). Use this to avoid mail loops when sending automated replies.

```typescript
import { isAutoReplyEmail } from "agents/email";
import PostalMime from "postal-mime";

async onEmail(email: AgentEmail) {
  const raw = await email.getRaw();
  const parsed = await PostalMime.parse(raw);

  // Detect and skip auto-reply emails
  if (isAutoReplyEmail(parsed.headers)) {
    console.log("Skipping auto-reply");
    return;
  }

  // Process the email...
}
```
