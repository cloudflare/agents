# Computer Skills

A Think agent whose [Agent Skills](https://agentskills.io) are plain files in its `@cloudflare/computer` Workspace.

## Run

You need Wrangler authenticated against an account with Workers AI access. The example uses `ai.remote: true` and a Worker Loader binding, so local development calls Cloudflare services.

```bash
pnpm install
pnpm run start
```

Open the local URL and try one of the prompts. The sidebar lists the skills in the Workspace. Add or delete one there, and the model sees the change on its next message.

## How it works

Every `/workspace/.agents/skills/<name>/SKILL.md` is a skill. The files beside it (`scripts/`, `references/`, `assets/`) are its resources:

```
/workspace/.agents/skills/
  release-notes/
    SKILL.md
    references/style-guide.md
    scripts/format-release-notes.js
  workspace-digest/
    SKILL.md
    scripts/digest.js
  pirate-voice/
    SKILL.md
```

Think reads skills from the Workspace with `skills.workspace()`:

```ts
import { Workspace } from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { Think, skills } from "@cloudflare/think";

export class SkillsAgent extends Think<Env> {
  override workspace = new Workspace({
    storage: this.ctx.storage,
    backends: [
      new WorkerJavaScriptBackend({ id: "js", loader: this.env.LOADER })
    ]
  });

  override getSkills() {
    return [skills.workspace(this.workspace)]; // /workspace/.agents/skills
  }
}
```

Think lists the folder before each turn. It adds the skill names and descriptions to the system prompt and gives the model `activate_skill` and `read_skill_resource`. Each `SKILL.md` is checked against the Agent Skills spec: a skill whose `name` does not match its folder, or that has no `description`, is skipped and logged.

Skill scripts are Workspace files as well. The model runs them with Computer's `exec` tool, from the skill's folder:

```js
export { default } from "./scripts/format-release-notes.js";
```

The agent writes its starter skills into the Workspace the first time it starts (`src/skill-files.ts`). After that the Workspace is the only copy, so edits and deletions persist.

## Related

- [`r2-skills`](../r2-skills): the same skills, loaded from an R2 bucket
- [`workspace-chat`](../workspace-chat): a chat agent with a Computer Workspace
