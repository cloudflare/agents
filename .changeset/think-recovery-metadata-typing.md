---
"@cloudflare/think": patch
---

Keep new metadata keys added by a recovery continuation even when their names match built-in object properties such as `toString` or `constructor`; previously they were dropped. Messenger typing indicators are now sent one at a time and settle before the first reply text is posted, so a slow indicator request can no longer re-show "typing" after the reply appears.
