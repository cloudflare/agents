---
"@cloudflare/think": minor
---

Replatform Think message, context, compaction, search, and media persistence onto `agents/sessions`. Think keeps its existing arrays, wire behavior, and `mediaEviction` policy while Sessions owns attachment bytes in chunked SQLite with optional R2. Project Agent Skills into Computer or legacy Shell workspaces without coupling conversation storage to Workspace. Custom workspace proxies only need binary writes in addition to the existing file-tool contract.
