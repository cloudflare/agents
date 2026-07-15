---
"@cloudflare/shell": patch
---

fix(shell): replace LIKE pattern matching with primary-key range scans in `Workspace.rm({ recursive: true })` and the `glob` prefilter. D1 can reject the previous `LIKE ? ESCAPE ?` queries with `D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR`; the range predicate (`path >= '{dir}/' AND path < '{dir}0'`) avoids that limit, scans the `path` index directly, and needs no escaping of `%`/`_` in path names.
