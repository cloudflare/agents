---
"@cloudflare/worker-bundler": minor
---

Add a `virtualModules` option to `createWorker`. Each key is an import specifier (for example `"node:fs"` or `"virtual:app/config"`) and each value is JavaScript module source made available during bundling. Only applies when `bundle: true`; in transform-only mode it is ignored with a warning.
