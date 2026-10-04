---
"@cloudflare/worker-bundler": patch
---

Resolve package subpath imports such as `ajv/dist/compile/codegen` to the requested file when the package has a `main` field but no `exports` map. They previously resolved to the package's root entrypoint.
