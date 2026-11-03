# R2 Skills

A Think agent that loads [Agent Skills](https://agentskills.io) from an R2 bucket.

## Run

You need Wrangler authenticated against an account with Workers AI access. The example uses `ai.remote: true` and a Worker Loader binding, so local development calls Cloudflare services. In local development the bucket is simulated.

```bash
pnpm install
pnpm run start
```

Open the local URL and try one of the prompts. The sidebar lists the skills in the bucket. Add or delete one there, and the model sees the change on its next message.

## How it works

Every `skills/<name>/SKILL.md` object is a skill. The objects beside it are its resources:

```
skills/
  release-notes/SKILL.md
  release-notes/references/style-guide.md
  release-notes/scripts/format-release-notes.js
  pirate-voice/SKILL.md
```

Think reads skills from the bucket with `skills.r2()`:

```ts
import { Think, skills } from "@cloudflare/think";

export class SkillsAgent extends Think<Env> {
  override getSkills() {
    return [skills.r2(this.env.SKILLS_BUCKET, { prefix: "skills/" })];
  }

  // Experimental: runs skill scripts in a Dynamic Worker via run_skill_script.
  override getSkillScriptRunner() {
    return skills.runner({ loader: this.env.LOADER });
  }
}
```

Think lists the bucket before each turn. By default `skills.r2()` reuses a listing for 60 seconds; this example sets `refreshIntervalMs: 0` so uploads show up immediately. Each `SKILL.md` is checked against the Agent Skills spec, and skills that break it are skipped and logged.

R2 has nowhere to run scripts, so the example uses the experimental skill script runner. JavaScript scripts export `default async function (input, ctx)` and read bundled files from `ctx.files`. To store and run skills as files instead, use a Computer Workspace, as [`computer-skills`](../computer-skills) does.

The agent uploads its starter skills the first time it finds the bucket empty (`src/skill-files.ts`). For a deployed bucket, upload skills yourself:

```bash
npx wrangler r2 object put agent-skills/skills/pirate-voice/SKILL.md --file ./pirate-voice/SKILL.md --remote
```

## Related

- [`computer-skills`](../computer-skills): skills as files in a Computer Workspace
