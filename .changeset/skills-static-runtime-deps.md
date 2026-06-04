---
"agents": patch
"@cloudflare/think": patch
---

The skill runner now imports `just-bash` and `@cloudflare/codemode` statically instead of dynamically, and both have moved from optional peer dependencies to regular dependencies of `agents`. The dynamic imports were ineffective in bundled Workers (the bundler includes them eagerly regardless) and triggered `INEFFECTIVE_DYNAMIC_IMPORT` warnings when bundled alongside `@cloudflare/think`, which imports them statically. `@cloudflare/think` also now statically imports its internal `ExtensionManager` instead of dynamically, removing the third such warning.
