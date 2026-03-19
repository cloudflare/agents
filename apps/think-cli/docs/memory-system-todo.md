# Memory System — Design TODO

What we need to store, how context blocks work, and how skills and workspace
tracking fit together.

---

## Context Blocks

The system prompt is built from **context blocks** — named sections that are
assembled at prompt time. Some are static, some are dynamic, some are loaded
on demand.

```
┌──────────────────────────────────────────────┐
│  identity          (static)                  │
│  tools             (static)                  │
│  guidelines        (static)                  │
│  memory            (dynamic — from files)    │
│  skills            (dynamic — discovered)    │
│  workspaces        (dynamic — tracked)       │
│  environment       (dynamic — detected)      │
│  user-context      (dynamic — from config)   │
└──────────────────────────────────────────────┘
```

Each block has a name, a priority, and a loader. The prompt assembler
concatenates them in order.

---

## Memory Block

### What goes in memory

| Scope | File | What it stores | Example |
|-------|------|----------------|---------|
| **Global** | `~/.config/think/memory.md` | Cross-project preferences, style, patterns | "Prefers TypeScript. Uses 2-space indent. Always writes tests." |
| **Project** | `.think/memory.md` | Shared team knowledge (committed to git) | "Monorepo. Build: `nx build`. Entry point: `apps/cli/src/main.ts`" |
| **Local** | `.think/local/memory.md` | Personal WIP, not committed | "Working on auth refactor. Left off at token refresh logic." |

### How memory gets written

No special tool. The agent uses `write` to update memory files. The prompt
tells it where they live:

```
To save information for future sessions, write to:
- Global: ~/.config/think/memory.md
- Project: .think/memory.md
- Local: .think/local/memory.md (gitignored)
```

### Staleness

Every memory file gets a staleness check based on mtime. If older than 1 day,
a `<system-reminder>` tag wraps it:

```
<system-reminder>This memory is 14 days old. Verify against current code
before asserting as fact.</system-reminder>
```

This is critical. Without it the model will confidently cite a file path from
two weeks ago that no longer exists.

---

## Skills Block

### How pi does it (what we should copy)

Pi uses **progressive disclosure**:

1. At startup, scan skill directories and extract **name + description only**
2. Inject a compact listing into the system prompt (XML format)
3. When the model decides a skill is relevant, it uses `read` to load the full
   SKILL.md on demand
4. The model follows the instructions from the skill

**No special tool needed.** The model uses the existing `read` tool to load
skills. The system prompt just tells it where skills live and what's available.

The skill listing in the system prompt looks like:

```xml
<available-skills>
  <skill name="commit" description="Generate conventional commit messages from staged changes" />
  <skill name="review-pr" description="Review a pull request for bugs, style, and correctness" />
  <skill name="deploy" description="Deploy the current branch to staging or production" />
</available-skills>
```

This costs ~50 tokens for a few skills. The full skill content (which could be
thousands of tokens) is only loaded when needed.

### How Claude Code does it

Claude Code also does progressive disclosure but with a twist:

1. Skills are listed in the system prompt as available commands
2. User invokes with `/skill-name` or the model invokes via a `SubAgent` tool
3. When invoked, the skill content is injected as a **user message** with
   metadata tags (`<skill-name>`, `<skill-format>true</skill-format>`)
4. For sub-agents, skills can be **preloaded** — injected into the agent's
   message history at spawn time

The key difference: Claude Code wraps skill invocation in its command system
(`/commit`, `/review-pr`), while pi lets the model decide when to load skills
via `read`.

### What we should do

Follow pi's approach — it's simpler and doesn't need a dedicated tool:

1. **Discover** — scan `~/.config/think/skills/`, `.think/skills/`, and any
   configured paths at startup
2. **List** — inject `<available-skills>` block into the system prompt with
   name + description
3. **Load** — when the model needs a skill, it `read`s the SKILL.md file
4. **Follow** — the model follows the instructions in the skill

Skills that are loaded during a session get added to a **loaded skills**
context block so the model doesn't re-read them:

```
# Loaded Skills

## commit (from .think/skills/commit/SKILL.md)
[full skill content here after first read]
```

This avoids redundant file reads and keeps the skill content in context for
the rest of the session.

### Skill format

Follow the [Agent Skills standard](https://agentskills.io/specification):

```
my-skill/
├── SKILL.md              # Required: frontmatter + instructions
├── scripts/              # Helper scripts
└── references/           # Detailed docs loaded on-demand
```

```yaml
---
name: my-skill
description: What this skill does and when to use it.
---

# My Skill

Instructions here...
```

---

## Workspaces Block

When the agent clones a repo or the user points it at a directory, we track it
in a **workspaces context block**. This gives the model spatial awareness of
what's available locally.

### How it works

The workspace registry lives in the local memory file (`.think/local/memory.md`
or a dedicated `.think/local/workspaces.md`). When the agent clones a repo or
discovers a local project, it writes an entry:

```markdown
# Workspaces

Local repos and projects the agent knows about.

| Path | Name | Description | Last accessed |
|------|------|-------------|---------------|
| ./agents | agents | Cloudflare Agents SDK monorepo | 2026-03-19 |
| ./pi-mono | pi-mono | Pi coding agent monorepo | 2026-03-18 |
| ./my-app | my-app | Next.js app with auth | 2026-03-17 |
| ~/Documents/notes | notes | Personal markdown notes | 2026-03-15 |
```

### When to update

- **Clone**: after `git clone`, write the entry
- **cd / navigate**: when the agent starts working in a new directory, update
  "last accessed"
- **Manual add**: user says "track this repo" → agent writes the entry
- **Remove**: user says "forget about X" → agent removes the entry

### What goes in the system prompt

The workspace block is injected as a simple list:

```
# Workspaces

Known local repositories and projects:
- ./agents — Cloudflare Agents SDK monorepo
- ./pi-mono — Pi coding agent monorepo
- ./my-app — Next.js app with auth
```

This is ~30-50 tokens for a handful of projects. The model can then reference
these by name ("look at the agents repo") without needing the full path every
time.

### Why this matters

Without workspace tracking:
- User: "check the agents repo for how they do MCP"
- Agent: "I don't know where that is. What's the path?"

With workspace tracking:
- User: "check the agents repo for how they do MCP"
- Agent: *reads from ./agents/packages/agents/src/mcp.ts*

The model has a mental map of the local filesystem. Simple, high leverage.

---

## Context Block Assembly (Pseudocode)

```typescript
interface ContextBlock {
  name: string;
  priority: number;        // lower = earlier in prompt
  loader: () => string | null;  // null = skip this block
  dynamic?: boolean;       // if true, re-evaluate every turn
}

const blocks: ContextBlock[] = [
  {
    name: "identity",
    priority: 0,
    loader: () => IDENTITY,
  },
  {
    name: "tools",
    priority: 10,
    loader: () => formatTools(registeredTools),
  },
  {
    name: "guidelines",
    priority: 20,
    loader: () => GUIDELINES,
  },
  {
    name: "memory",
    priority: 30,
    dynamic: true,
    loader: () => {
      const memories = loadMemoryFiles(cwd);
      if (memories.length === 0) return null;
      return formatMemoriesWithStaleness(memories);
    },
  },
  {
    name: "skills",
    priority: 40,
    loader: () => {
      const skills = discoverSkills(cwd);
      if (skills.length === 0) return null;

      const listing = skills.map(s =>
        `  <skill name="${s.name}" description="${s.description}" path="${s.path}" />`
      ).join("\n");

      return [
        "# Skills",
        "",
        "Available skills (use read to load full instructions when needed):",
        "",
        "<available-skills>",
        listing,
        "</available-skills>",
      ].join("\n");
    },
  },
  {
    name: "loaded-skills",
    priority: 45,
    dynamic: true,
    loader: () => {
      // Skills that have been read during this session
      // Populated when the model reads a SKILL.md via the read tool
      if (loadedSkills.size === 0) return null;

      const sections = Array.from(loadedSkills.entries()).map(
        ([name, content]) => `## ${name}\n\n${content}`
      );

      return `# Loaded Skills\n\n${sections.join("\n\n")}`;
    },
  },
  {
    name: "workspaces",
    priority: 50,
    dynamic: true,
    loader: () => {
      const workspaces = loadWorkspaceRegistry(cwd);
      if (workspaces.length === 0) return null;

      const lines = workspaces.map(w =>
        `- ${w.path} — ${w.description || w.name}`
      );

      return `# Workspaces\n\nKnown local repositories and projects:\n${lines.join("\n")}`;
    },
  },
  {
    name: "environment",
    priority: 60,
    loader: () => [
      "# Environment",
      "",
      `Date: ${new Date().toISOString().split("T")[0]}`,
      `Working directory: ${cwd}`,
      `OS: ${process.platform}`,
    ].join("\n"),
  },
  {
    name: "user-context",
    priority: 70,
    loader: () => {
      // .think/instructions.md or similar
      const path = join(cwd, ".think", "instructions.md");
      if (!existsSync(path)) return null;
      return readFileSync(path, "utf-8");
    },
  },
];

function assembleSystemPrompt(): string {
  return blocks
    .sort((a, b) => a.priority - b.priority)
    .map(b => b.loader())
    .filter(Boolean)
    .join("\n\n");
}
```

---

## Open Questions

### 1. Should loaded skills stay in the system prompt or message history?

**System prompt (pi approach):** Re-injected every turn. Simple but costs
tokens on every call.

**Message history (Claude Code approach):** Injected once as a user message.
Stays in context via conversation history. More efficient but gets lost on
context compression.

**Recommendation:** Start with message history. If context compression drops
skills too early, move to system prompt with a token budget cap.

### 2. Should workspace tracking be automatic or manual?

**Automatic:** Watch for `git clone` in the code tool, auto-register. Risk of
cluttering with temp repos.

**Manual:** Agent writes entries only when the user asks or when it makes sense
in conversation. More intentional.

**Recommendation:** Semi-automatic. The agent writes workspace entries as part
of its normal workflow (after cloning, after navigating to a new project) but
doesn't watch the filesystem. The prompt should say:

```
When you clone a repo or start working in a new project directory,
update .think/local/workspaces.md with the path and description.
```

### 3. Memory file size limits?

If someone dumps a whole architecture doc into memory, the system prompt
balloons. We should cap:

- Global memory: 2KB
- Project memory: 4KB
- Local memory: 4KB
- Workspace list: 2KB

If a file exceeds its budget, truncate with a note:
`[truncated — edit this file to keep it under 4KB]`

### 4. Config directory name?

Options:
- `.think/` — matches the CLI name
- `.agents/` — generic, compatible with other tools
- Both — discover from either, write to `.think/`

**Recommendation:** Use `.think/` as primary, but also discover from `.agents/`
for cross-tool compatibility (same as pi discovering from `.claude/`).

---

## Implementation Order

1. **Memory files** — load/format/staleness. This alone gives us 80% of the value.
2. **Skill discovery** — scan + list in prompt. No tool needed.
3. **Workspace tracking** — simple markdown registry + prompt injection.
4. **Loaded skills cache** — populate when model reads a SKILL.md.
5. **Context block assembler** — formalize the priority system.

Start with 1. Ship it. Everything else layers on.
