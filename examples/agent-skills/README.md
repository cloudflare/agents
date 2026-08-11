# Agent Skills

This example demonstrates first-class Agent Skills in Think using a bundled
skills directory imported with the `agents:skills` specifier.

## Run

You need Wrangler authenticated against an account with Workers AI access. The
example uses `ai.remote: true` and a Worker Loader binding, so local development
calls Cloudflare services.

```bash
npm install
npm start
```

Script execution uses the Worker Loader binding in `wrangler.jsonc`:

```jsonc
{
  "worker_loaders": [{ "binding": "LOADER" }]
}
```

Open the local Vite URL and try one of the suggested prompts. When the model
calls `activate_skill`, that skill lights up in the sidebar. Skill tool activity
from `activate_skill` and `run_skill_script` appears in the chat.

The agent has:

- `release-notes`, with a TypeScript formatting script that reads its bundled
  style guide through workspace-backed `node:fs`
- `test-plan`, a procedure-style skill that turns a change description into a
  prioritized test plan
- `debug-plan`, with an extra reference file
- `pirate-voice`

## Key pattern

The agent configures a Computer workspace with `WorkerJavaScriptBackend`:

```ts
import type { DurableObjectStorageLike } from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { Workspace } from "@cloudflare/think/workspace";

class SkillsAgent extends Think<Env> {
  override workspace = new Workspace({
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    backends: [
      new WorkerJavaScriptBackend({
        loader: this.env.LOADER,
        root: "/workspace",
        access: "read-write",
        globalOutbound: null
      })
    ]
  });
}
```

`getSkillScriptRunner()` writes the selected compiled script and its resources
to a temporary workspace directory. It then runs a small module through the
common workspace runtime:

```ts
const handle = await this.workspace.runtime.exec(
  `export { default } from ${JSON.stringify(`./${request.path}`)};`,
  {
    backend: "worker-javascript",
    cwd: runRoot,
    input: request.input,
    encoding: "utf8"
  }
);
const result = await handle.result();
```

The JavaScript backend calls the module's default export with `input`. Scripts
use `node:fs` or `node:fs/promises` to read bundled resources and work with the
agent's durable workspace. The runner uses a separate directory for each call
and removes the materialized skill files after execution. Changes that a script
makes elsewhere in `/workspace` remain durable.

The Agents Vite plugin compiles TypeScript before it reaches the Worker. The
example keeps filesystem imports for the runtime instead of asking the build to
bundle them:

```ts
agents({ skillScriptExternals: ["node:fs", "node:fs/promises"] });
```

See [`src/server.ts`](src/server.ts) for input validation, binary resource
handling, nonzero exit handling, and cleanup.

## Related

- [`design/skills.md`](../../design/skills.md)
- [`examples/think-submissions`](../think-submissions)
