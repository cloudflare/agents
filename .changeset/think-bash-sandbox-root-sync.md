---
"@cloudflare/think": patch
---

Fix the bash tool destroying workspace content under `/tmp`, `/bin`, `/usr`, `/dev`, `/proc` and `/sys`. Pre-existing workspace directories below a sandbox root were deleted after every run, and writes into them — new files, new subdirectories, renames — were silently discarded so a `mv` inside such a directory lost the file. Workspace ownership is now decided by ancestry: a path syncs if it is, or descends from, a workspace directory below a sandbox root. Only paths created directly under a root remain the shell's own scratch, and the roots themselves are never deleted.
