---
"@cloudflare/think": patch
---

Fix the bash tool destroying workspace content under `/tmp`, `/bin`, `/usr`, `/dev`, `/proc` and `/sys`. Pre-existing workspace directories below a sandbox root were deleted after every run, and writes into them — new files, new subdirectories, renames — were silently discarded so a `mv` inside such a directory lost the file. Workspace ownership is now decided by ancestry: a path syncs if it is, or descends from, a workspace directory below a sandbox root. Shell infrastructure directories are excluded from that ancestry — the sandbox writes a file per builtin into `/bin` and `/usr/bin`, and a workspace holding `/usr/bin` must not adopt them — while exact workspace files there keep syncing. An entry a `mv` carried onto a sandbox root is kept when its contents match a workspace subtree that vanished from the same root. Everything else created directly under a root remains the shell's own scratch, and the roots themselves are never deleted.
