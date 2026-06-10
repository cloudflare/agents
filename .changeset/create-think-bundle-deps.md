---
"create-think": patch
---

Bundle runtime dependencies (`tiged`, `yargs`, and their transitive deps) into the published output. `create-think` now ships as a fully self-contained package, so `npm create think` is a single download that runs without resolving or installing any transitive dependencies.
