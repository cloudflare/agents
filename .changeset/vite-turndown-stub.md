---
"agents": patch
---

The `agents/vite` plugin now stubs `turndown` by default. `turndown` (pulled in transitively by `just-bash` for the workspace bash tool and skill runner) runs a top-level `require()` in its Node DOM fallback, which throws `ReferenceError: require is not defined` at Worker startup — even when the bash tool is never used. The plugin replaces it with an inert stub so Workers deploys stay clean. Opt out with `agents({ stubTurndown: false })` if your app uses `turndown` directly.
