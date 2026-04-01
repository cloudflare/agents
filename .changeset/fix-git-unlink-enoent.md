---
"@cloudflare/shell": patch
---

Fix `git.clone()` without `depth` failing with `ENOENT: .git/shallow`. The git fs adapter's `unlink` now wraps errors with `.code` so isomorphic-git can handle missing files gracefully.
