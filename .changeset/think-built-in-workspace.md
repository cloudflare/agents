---
"@cloudflare/think": patch
---

Add built-in workspace to Think. Every Think instance now has `this.workspace` backed by the DO's SQLite storage, and workspace tools (read, write, edit, list, find, grep, delete) are automatically merged into every chat turn. Override `workspace` to add R2 spillover for large files. `@cloudflare/shell` is now a required peer dependency.
