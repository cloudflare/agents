---
"@cloudflare/think": minor
---

Think no longer depends on `@cloudflare/shell`. The execute tool's `state` option is removed, along with the `state.*` sandbox namespace it added. To give sandboxed code the workspace, pass the workspace tools: `createExecuteTool(this, { tools: createAITools({ workspace: this.workspace }) })`.
