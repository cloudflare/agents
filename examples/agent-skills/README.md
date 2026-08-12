# Agent Skills

This example demonstrates first-class Agent Skills in Think using a bundled
skills directory imported with the `agents:skills` specifier.

## Run

You need Wrangler authenticated against an account with Workers AI access. The
example uses `ai.remote: true`, so local development calls Cloudflare services.

```bash
npm install
npm start
```

Open the local Vite URL and try one of the suggested prompts. When the model
calls `activate_skill`, that skill lights up in the sidebar. Calls to
`activate_skill` and `read_skill_resource` appear inline in the chat.

The agent has:

- `release-notes` available through `activate_skill`, with a bundled style guide
  that the model reads through `read_skill_resource`
- `test-plan` available through `activate_skill` — a procedure-style skill that
  turns a change description into a prioritized test plan
- `debug-plan` available through `activate_skill`, with an extra reference file
- `pirate-voice` available through `activate_skill`

## Key pattern

```ts
import { Think } from "@cloudflare/think";
import bundledSkills from "agents:skills"; // -> ./skills next to this file

export class SkillsAgent extends Think<Env> {
  getSkills() {
    return [bundledSkills];
  }
}
```

The `agents/vite` plugin turns the local `src/skills/*/SKILL.md` directories
into a `SkillSource` that Think can register at startup. Skills provide
on-demand instructions and bundled resources. The model activates matching
instructions with `activate_skill` and reads references, templates, scripts,
or assets with `read_skill_resource`.

## Related

- [`design/skills.md`](../../design/skills.md)
- [`examples/think-submissions`](../think-submissions)
