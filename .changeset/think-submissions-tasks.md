---
"@cloudflare/think": patch
---

Programmatic submissions are stored as Tasks runs; existing `cf_think_submissions` rows move over on the first start, and the submission API is unchanged.
