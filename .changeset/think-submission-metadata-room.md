---
"@cloudflare/think": patch
---

`submitMessages` refuses metadata that leaves no room for the submission's own progress (about 1.8 MB), and ignores an app field named `__cf_progress`, so a completed submission always records its message id.
