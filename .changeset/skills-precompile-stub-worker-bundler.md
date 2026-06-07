---
"agents": patch
---

Compile skill scripts ahead of time and remove the in-Worker bundler (drops ~14MB of `esbuild-wasm` from Worker bundles).

Skill scripts are now always compiled to self-contained JavaScript before they run, and the runtime no longer ships an in-Worker bundler (`@cloudflare/worker-bundler` is no longer a dependency of `agents`):

- The Agents Vite plugin compiles bundled skill scripts (`scripts/*.ts`/`.tsx`/`.js`/`.mjs`) with esbuild at build time — resolving sibling imports and stripping TypeScript — and marks them `precompiled`.
- Skills served from R2 or other dynamic sources must be compiled before upload. A new `compileSkillScript` helper is exported from `agents/skills/compile` for use in your publish/upload tooling.
- At runtime, a skill script that still needs compiling (raw TypeScript or a multi-file skill that wasn't bundled) throws a clear "must be compiled to a self-contained JavaScript module" error instead of silently bundling in-Worker.

**Breaking:** if you ship raw TypeScript or multi-file skill scripts to R2 (or another dynamic source) and relied on the in-Worker bundler to compile them at runtime, bundle them ahead of time (e.g. with `compileSkillScript`) before upload. Bundled skills handled by the Vite plugin require no changes. The previously-added `stubWorkerBundler` option has been removed (there is nothing left to stub).
