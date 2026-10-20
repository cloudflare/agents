# Codemode

`@cloudflare/codemode` exports `WorkerJavaScriptBackend`, which runs JavaScript in a fresh Dynamic Worker. The code reads files through `node:fs` and calls functions in your Durable Object through host modules (`ws:*`). [`@cloudflare/computer`](https://github.com/cloudflare/computer) runs Workspace code on it, and you can use it without Computer.

- [`WorkerJavaScriptBackend`](./worker-javascript.md): connecting it, what code looks like, modules and limits

To give a model a code tool, use the `exec` tool from `@cloudflare/computer` on a Workspace with a `WorkerJavaScriptBackend`. Computer adds the Workspace filesystem, the `ws:tools` module for an agent's tools, and the model-facing tool definitions.

## The legacy API

Everything else the package exports is the original Code Mode API: `createCodeTool`, `DynamicWorkerExecutor`, connectors, the durable runtime with approvals and snippets, the MCP helpers, the browser executor and the Vite plugin. It is feature-frozen. It keeps working and won't change, but it is no longer maintained, and every export is marked `@deprecated`. The code lives in [`packages/codemode/src/legacy`](../../packages/codemode/src/legacy) so you can copy it into your project.

- [The legacy API](./legacy.md): what is frozen, what replaces each piece, and copying it
- [How the legacy API works](./legacy-overview.md) and the [legacy API reference](./legacy-reference.md)
- [Connectors](./connectors.md), [Runtime](./runtime.md), [Approvals](./approvals.md), [Snippets](./snippets.md), [Vite Plugin](./vite-plugin.md)
