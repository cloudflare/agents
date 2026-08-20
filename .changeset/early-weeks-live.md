---
"@cloudflare/worker-bundler": patch
---

Add Python package support.

Existing worker-bundler users should note:

- Automatic dependency installation accepts either `package.json` or `pyproject.toml`, not both. Projects that provide both must remove one manifest from the bundler input or install dependencies separately.
- `index.py` is now considered before `src/worker.ts` and `src/worker.js` during default entry-point detection. Set `entryPoint`, `server`, or `wrangler.main` in projects where that is ambiguous.
- Custom `FileSystem.write()` implementations used with Python packages must accept both strings and `{ data: Uint8Array }` binary entries.
