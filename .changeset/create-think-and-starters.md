---
"@cloudflare/think": patch
---

Add a `--template` flag to `think init` and a programmatic `@cloudflare/think/cli` entry point. `think init` now scaffolds from the repo's starter templates (locally, or via an injected fetcher) instead of generating a single inline app. This is what powers the new `create-think` package.
