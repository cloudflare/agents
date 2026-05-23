# Agent Skills

This example demonstrates first-class Agent Skills in Think using a bundled
skills directory imported with `type: "skills"`.

## Run

```bash
npm install
npm start
```

Open the local Vite URL and try one of the suggested prompts. The agent has:

- `brand-voice` available through `activate_skill`
- `release-notes` available through `activate_skill`
- `debug-plan` available through `activate_skill`, with an extra reference file
- `pirate-voice` available through `activate_skill`

## Key Pattern

```ts
import bundledSkills from "./skills" with { type: "skills" };

export class SkillsAgent extends Think<Env> {
  getSkills() {
    return [bundledSkills];
  }
}
```

The `agents/vite` plugin turns the local `src/skills/*/SKILL.md` directories
into a `SkillSource` that Think can register at startup.

## Related

- [`design/skills.md`](../../design/skills.md)
- [`examples/think-submissions`](../think-submissions)
