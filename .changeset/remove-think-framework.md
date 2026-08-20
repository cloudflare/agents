---
"@cloudflare/think": minor
---

Remove the convention-driven Think framework, including the Vite plugin, generated Worker entry and virtual modules, CLI, Studio, framework helpers, and server-entry helpers. Remove the separate `create-think` scaffolder and its starter templates. Think remains available as an explicit runtime for hand-written Worker entries.

**Migration for existing framework users**

If you only use the `Think` runtime, React integration, messengers, workflows, extensions, or tools, no migration is required.

| Existing use                                      | Required change                                                                                                                                                             |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@cloudflare/think/vite`                          | Use `agents/vite` for decorators and `agents:skills`, alongside `@cloudflare/vite-plugin`.                                                                                  |
| `virtual:think/entry`                             | Add a real Worker entry, such as `src/server.ts`, that explicitly exports each Think class.                                                                                 |
| Generated bindings, migrations, and routing       | Declare top-level Durable Object bindings and migrations in `wrangler.jsonc`; route with `routeAgentRequest()` and, for custom sub-agent routing, `routeSubAgentRequest()`. |
| `@cloudflare/think/framework`                     | Move generated configuration and class exports into application code.                                                                                                       |
| `@cloudflare/think/server-entry`                  | Use Agents SDK routing helpers and application-owned request handlers.                                                                                                      |
| `think types`                                     | Use `wrangler types`.                                                                                                                                                       |
| `think init` or `create-think`                    | Use `npx create-cloudflare@latest --template cloudflare/agents-starter`, or manually configure a Think Worker.                                                              |
| `think studio`, `think state`, or `think inspect` | No direct replacement.                                                                                                                                                      |

Existing deployments must preserve generated `ThinkAgent_*` and `ThinkSubAgent_*` constructor names and existing migration history. Sub-agent registries use `Class.name`, so export aliases alone do not preserve compatibility. If renaming classes, use a data-preserving Durable Object rename migration.
