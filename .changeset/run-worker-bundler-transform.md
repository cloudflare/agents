---
"@cloudflare/worker-bundler": patch
---

Add a narrow `@cloudflare/worker-bundler/transform` subpath export exposing
exactly `transformCode`, `TransformOptions`, and `TransformResult` for
single-module TypeScript stripping without pulling in the bundler.
