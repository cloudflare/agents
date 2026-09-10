---
"@cloudflare/think": patch
---

Fix the bash tool deleting pre-existing workspace directories under `/tmp`, `/bin`, `/usr`, `/dev`, `/proc` and `/sys` after every run. The sync pass now treats workspace-owned directories below a sandbox root like any other directory and skips only the roots themselves.
