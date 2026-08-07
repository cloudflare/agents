---
"@cloudflare/think": minor
---

Use a backend-free `@cloudflare/computer` workspace as the default Think workspace. File tools now use the Computer `workspace.fs` API, and existing legacy data is not migrated automatically.

Codemode automatically exposes Computer workspaces under `workspace.*`, renaming Computer's `ls` tool to `list`. The legacy workspace retains its richer `state.*` connector.
