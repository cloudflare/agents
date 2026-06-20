---
"@cloudflare/think": patch
---

Route Think turn entry points through a shared internal `_admitTurn` spine and
throw a clear error for nested blocking turn admissions that previously could
deadlock.
