# Agent Skills

This example demonstrates first-class Agent Skills in Think using a bundled
skills directory imported with `type: "skills"`.

## Run

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

Open the local Vite URL and try one of the suggested prompts. The agent has:

- `brand-voice` available through `activate_skill`
- `release-notes` available through `activate_skill`, with a harmless formatting
  script, Bash input-inspection script, and Python summary script runnable
  through `run_skill_script`
- `debug-plan` available through `activate_skill`, with an extra reference file
- `pirate-voice` available through `activate_skill`

## Key Pattern

```ts
import { Think, skills } from "@cloudflare/think";
import bundledSkills from "./skills" with { type: "skills" };

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
    return skills.workerScriptRunner({
      loader: this.env.LOADER,
      workspaceInstance: this.workspace
    });
  }
}
```

The `agents/vite` plugin turns the local `src/skills/*/SKILL.md` directories
into a `SkillSource` that Think can register at startup. The optional script
runner executes JavaScript/TypeScript files under `scripts/` in a sandboxed
Worker, using `@cloudflare/worker-bundler` to compile TypeScript and bundle
sibling script imports. It runs `.py` files as Python Dynamic Workers, and
`.sh`/`.bash` files through `just-bash`, with `/input.json`, `/context.json`, and
bundled resources under `/skill` materialized for those runtimes. Script
execution requires the `worker_loaders` binding shown in `wrangler.jsonc`.
Passing `workspaceInstance` gives scripts read-only workspace access by default;
opt in to `workspace: "read-write"`, tools, or network only when a skill needs
them. The default 30 second timeout leaves room for TypeScript compilation and
Dynamic Worker cold starts in local development.

## Related

- [`design/skills.md`](../../design/skills.md)
- [`examples/think-submissions`](../think-submissions)
