# Agent Skills

This example demonstrates first-class Agent Skills in Think using a bundled
skills directory imported with the `agents:skills` specifier.

## Run

You need Wrangler authenticated against an account with Workers AI access. The
example uses `ai.remote: true` and a Worker Loader binding, so local development
will call Cloudflare services.

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
calls `activate_skill`, that skill lights up in the sidebar, and skill tool
activity (`activate_skill` / `run_skill_script`) is shown inline in the chat.

The agent has:

- `release-notes` available through `activate_skill`, with a function-style
  TypeScript formatting script that reads a bundled style guide from `ctx.files`
  and is runnable through `run_skill_script`
- `test-plan` available through `activate_skill` — a procedure-style skill that
  turns a change description into a prioritized test plan
- `debug-plan` available through `activate_skill`, with an extra reference file
- `pirate-voice` available through `activate_skill`

## Key Pattern

```ts
import { Think, skills } from "@cloudflare/think";
import bundledSkills from "agents:skills"; // -> ./skills next to this file

type Env = {
  AI: Ai;
  LOADER: WorkerLoader;
  SkillsAgent: DurableObjectNamespace<SkillsAgent>;
};

export class SkillsAgent extends Think<Env> {
  getSkills() {
    return [bundledSkills];
  }

  getSkillScriptRunner() {
    return skills.runner({
      loader: this.env.LOADER,
      workspaceInstance: this.workspace
    });
  }
}
```

The `agents/vite` plugin turns the local `src/skills/*/SKILL.md` directories
into a `SkillSource` that Think can register at startup. The optional,
experimental script runner executes the TypeScript file under `scripts/` in a
sandboxed Worker, using `@cloudflare/worker-bundler` to compile TypeScript and
bundle sibling script imports. JS/TS scripts are function-style
(`export default async function run(input, ctx)`) and read bundled text files
from `ctx.files`, call explicit `ctx.tools`, access `ctx.workspace`, and write
scratch artifacts with `ctx.output.writeFile(name, content)`. The same runner
also supports Python and Bash scripts via the path-based `/input.json` /
`/skill` / `/output` contract — this example keeps it to TypeScript. Script
execution requires the `worker_loaders` binding shown in `wrangler.jsonc`.
Passing `workspaceInstance` gives scripts read-only workspace access by default;
opt in to `workspace: "read-write"`, tools, or network only when a skill needs
them. The default 30 second timeout leaves room for TypeScript compilation and
Dynamic Worker cold starts in local development.

## Related

- [`design/skills.md`](../../design/skills.md)
- [`examples/think-submissions`](../think-submissions)
