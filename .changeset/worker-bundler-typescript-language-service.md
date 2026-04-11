---
"@cloudflare/worker-bundler": minor
---

Add in-process TypeScript language service via `createTypescriptLanguageService`.

`createTypescriptLanguageService` wraps any `FileSystem` in a
`TypescriptFileSystem` that mirrors every write and delete into an underlying
virtual TypeScript environment. Diagnostics returned by the language service
always reflect the current state of the filesystem — an edit that fixes a type
error immediately clears `getSemanticDiagnostics`.

TypeScript is pre-bundled as a browser-safe artifact so it runs inside the
Workers runtime without Node.js APIs. Lib declarations are fetched from the
TypeScript npm tarball at runtime.

Exposed under a separate `./typescript` subpath export to keep the TypeScript
bundle out of the main import path.
