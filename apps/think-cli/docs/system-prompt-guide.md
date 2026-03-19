# Building a Minimal System Prompt for a Coding Agent

A guide to constructing effective system prompts with minimal surface area.
Based on analysis of pi (lean, ~50 lines) and Claude Code (enterprise, ~2000+ tokens assembled dynamically).

---

## Philosophy

The best system prompt is the shortest one that still produces correct behavior.

**Pi's approach:** Trust the model. Give it 4 tools, clear rules, and let it figure out the rest.
**Claude Code's approach:** Enumerate every edge case. Assemble the prompt dynamically from 10+ modules with feature flags.

We want pi's minimalism with Claude Code's memory system. That's it.

---

## Our Tool Set

| Tool | Purpose | Instead of... |
|------|---------|---------------|
| `read` | Read file contents (text + images) | `cat`, `head`, `tail`, `sed` |
| `edit` | Surgical find-and-replace edits | `sed`, `awk`, manual rewrites |
| `write` | Create or overwrite files | `cat` with heredoc, `echo >` |
| `code` | Execute code (shell, python, etc.) | General-purpose execution |

Four tools. That's the entire surface.

---

## Prompt Structure

The prompt is assembled from ordered sections. Each section is optional and injected only when relevant.

```
┌─────────────────────────────────┐
│ 1. Identity                     │  ← Static. Who are you.
│ 2. Tools                        │  ← Static. What you have.
│ 3. Guidelines                   │  ← Static. How to behave.
│ 4. Memory                       │  ← Dynamic. What you remember.
│ 5. Environment                  │  ← Dynamic. Where you are.
│ 6. User context                 │  ← Dynamic. Project-specific rules.
└─────────────────────────────────┘
```

### Section 1: Identity (static)

One line. Don't overthink it.

```
You are a coding assistant with access to file system tools and code execution.
```

That's it. No brand manifesto. No personality traits. The model already knows how to be helpful.

### Section 2: Tools (static)

Name each tool, say what it does, and say when to use it *instead* of alternatives.

```
Available tools:
- read: Read file contents. Use instead of cat, head, tail, sed.
- edit: Find-and-replace edits. Old text must match exactly. Use instead of sed/awk.
- write: Create or overwrite files. Use for new files or complete rewrites only.
- code: Execute code (shell commands, scripts). Reserve for execution that requires a runtime.

Use dedicated tools over code when possible. Don't use code to read files (use read).
Don't use code to edit files (use edit). Don't use code to create files (use write).
```

The key rule: **dedicated tools over general execution**. Claude Code hammers this point
with ~200 words. We do it in 3 lines.

### Section 3: Guidelines (static)

Short, imperative rules. Each rule exists because without it the model does something wrong.

```
Guidelines:
- Read files before editing. You must understand what you're changing.
- Use edit for precise changes. Old text must match exactly including whitespace.
- Use write only for new files or complete rewrites.
- Be concise. Don't narrate what you're about to do — just do it.
- When making multiple independent tool calls, make them in parallel.
- If calls depend on each other, make them sequentially. Don't guess at values.
```

**What NOT to include:**
- "Be helpful" — it already is
- "Don't hallucinate" — doesn't work, use tool design instead
- "Think step by step" — use thinking/reasoning tokens, not prompt hacks
- Personality instructions — save those for a wrapper, not the system prompt

### Section 4: Memory (dynamic)

See the full memory system below.

### Section 5: Environment (dynamic)

Injected at prompt assembly time. Minimal context about where the agent is running.

```
Current date: 2026-03-19
Working directory: /Users/matt/project
```

### Section 6: User Context (dynamic, optional)

Project-specific instructions from config files (like `.agent/instructions.md`).
Loaded from disk at session start. Treated as high-priority user instructions.

---

## Memory System

This is where Claude Code gets it right. Here's how they do it and how we should too.

### How Claude Code Memory Works (Pseudocode)

```typescript
// ============================================================
// MEMORY ARCHITECTURE
// ============================================================

// Memory is just markdown files on disk. No database. No embeddings.
// Files live in well-known locations and are loaded at prompt assembly time.

interface Memory {
  content: string;        // markdown text
  source: MemorySource;   // where it came from
  timestamp: number;      // when it was created/updated
}

type MemorySource =
  | "user"       // ~/.config/agent/memory.md  (global, all projects)
  | "project"    // .agent/memory.md           (per-project, checked in)
  | "local"      // .agent/.local/memory.md    (per-project, gitignored)

// ============================================================
// LOADING MEMORIES INTO THE SYSTEM PROMPT
// ============================================================

function assembleSystemPrompt(tools, env, memories): string {
  const sections: (string | null)[] = [
    // 1. Identity
    IDENTITY_LINE,

    // 2. Tools
    formatToolDescriptions(tools),

    // 3. Guidelines
    GUIDELINES,

    // 4. Memory — injected here, between guidelines and environment
    formatMemories(memories),

    // 5. Environment
    formatEnvironment(env),

    // 6. User context (from project config)
    loadUserContext(env.workingDir),
  ];

  return sections.filter(s => s !== null).join("\n\n");
}

// ============================================================
// FORMATTING MEMORIES FOR THE PROMPT
// ============================================================

function formatMemories(memories: Memory[]): string | null {
  if (memories.length === 0) return null;

  const formatted = memories.map(m => {
    const staleWarning = getStalenessWarning(m.timestamp);
    const header = `[${sourceLabel(m.source)}]`;
    return `${header}\n${staleWarning}${m.content}`;
  });

  return `# Memory\n${formatted.join("\n\n")}`;
}

// CRITICAL: Claude Code warns the model when memories are old.
// This prevents the model from asserting stale facts as current truth.
function getStalenessWarning(timestamp: number): string {
  const daysOld = Math.floor((Date.now() - timestamp) / 86400000);

  if (daysOld <= 1) return ""; // fresh, no warning

  return `<system-reminder>This memory is ${daysOld} days old. ` +
    "Memories are point-in-time observations, not live state — " +
    "claims about code behavior or file:line citations may be outdated. " +
    "Verify against current code before asserting as fact." +
    "</system-reminder>\n";
}

// ============================================================
// SAVING MEMORIES (during a session)
// ============================================================

// Claude Code doesn't have a "save memory" tool. Instead:
// 1. The model writes to memory files using the standard file tools
// 2. Memory files are just markdown — no special format
// 3. The system prompt tells the model WHERE to write memories

// The prompt includes something like:
// "To save information for future sessions, write to .agent/memory.md"

// ============================================================
// MEMORY FILE RESOLUTION ORDER
// ============================================================

function loadMemories(workingDir: string): Memory[] {
  const memories: Memory[] = [];

  // 1. Global user memory (cross-project preferences, style, etc.)
  const globalPath = path.join(os.homedir(), ".config", "agent", "memory.md");
  if (fs.existsSync(globalPath)) {
    memories.push({
      content: fs.readFileSync(globalPath, "utf-8"),
      source: "user",
      timestamp: fs.statSync(globalPath).mtimeMs,
    });
  }

  // 2. Project memory (shared with team via git)
  const projectPath = path.join(workingDir, ".agent", "memory.md");
  if (fs.existsSync(projectPath)) {
    memories.push({
      content: fs.readFileSync(projectPath, "utf-8"),
      source: "project",
      timestamp: fs.statSync(projectPath).mtimeMs,
    });
  }

  // 3. Local memory (personal, gitignored)
  const localPath = path.join(workingDir, ".agent", ".local", "memory.md");
  if (fs.existsSync(localPath)) {
    memories.push({
      content: fs.readFileSync(localPath, "utf-8"),
      source: "local",
      timestamp: fs.statSync(localPath).mtimeMs,
    });
  }

  return memories;
}

// ============================================================
// WHAT GOES IN MEMORY FILES
// ============================================================

// Global (~/.config/agent/memory.md):
//   - Preferred languages, frameworks
//   - Coding style (tabs vs spaces, naming conventions)
//   - Common patterns the user likes
//
// Project (.agent/memory.md):
//   - Architecture decisions
//   - Build/test commands
//   - Key file locations
//   - Team conventions
//
// Local (.agent/.local/memory.md):
//   - Personal notes about the project
//   - WIP state between sessions
//   - Things you don't want to commit
```

### Key Design Decisions

1. **Files, not databases.** Memory is plain markdown. The user can read, edit, and version-control it. No magic.

2. **Staleness warnings.** This is Claude Code's best idea. A memory from 30 days ago saying "the auth module is in `src/auth.ts`" might be wrong now. The warning tells the model to verify before asserting.

3. **Three scopes.** Global (user prefs), project (team knowledge), local (personal WIP). This covers every use case.

4. **No embedding search.** The entire memory is injected into the system prompt. This limits memory size but guarantees the model sees everything. For most projects, a few KB of memory is plenty.

5. **Model writes its own memories.** No special tool needed. The model uses `write` to update memory files. The prompt just tells it where they are.

---

## Complete Prompt Template

```
You are a coding assistant with access to file system tools and code execution.

# Tools

- read: Read file contents (text and images). Use instead of cat/head/tail.
- edit: Surgical find-and-replace. Old text must match exactly (including whitespace).
- write: Create or overwrite files. Creates parent directories automatically.
- code: Execute shell commands or scripts. Use only when you need a runtime.

Prefer dedicated tools over code. Don't use code to read/edit/write files.

# Guidelines

- Read files before editing them.
- Use edit for precise changes, write for new files or complete rewrites.
- Be concise. Show file paths when working with files.
- Make independent tool calls in parallel. Sequential only when dependent.
- If you need a value from a previous call, wait for it. Don't guess.

{MEMORY_SECTION}

# Environment

Date: {DATE}
Working directory: {CWD}
OS: {OS}

{USER_CONTEXT}
```

Where `{MEMORY_SECTION}` expands to:

```
# Memory

As you work, consult these memories. To save new memories, write to:
- Global: ~/.config/agent/memory.md (your cross-project preferences)
- Project: .agent/memory.md (shared project knowledge)
- Local: .agent/.local/memory.md (personal, gitignored)

[user]
{contents of ~/.config/agent/memory.md}

[project]
<system-reminder>This memory is 12 days old. Memories are point-in-time
observations, not live state — verify against current code before asserting
as fact.</system-reminder>
{contents of .agent/memory.md}

[local]
{contents of .agent/.local/memory.md}
```

---

## What We Deliberately Leave Out

| Thing | Why we skip it |
|-------|---------------|
| Permission system | Not needed for a single-user agent. Add later if needed. |
| Sub-agents | Complexity. One agent, four tools. |
| Output style instructions | Let the model decide. Override per-project in user context if needed. |
| "Don't hallucinate" | Doesn't work as a prompt instruction. Design tools to ground the model instead. |
| Personality | The model has one. It's fine. |
| URL safety rules | Niche edge case. Add to user context if you care. |
| Conversation compression instructions | That's a runtime concern, not a prompt concern. |

---

## Comparison: Token Costs

| Prompt | Approx. tokens |
|--------|---------------|
| Our minimal prompt (no memory) | ~250 |
| Our prompt with typical memory | ~500-1000 |
| Pi's full prompt | ~800 |
| Claude Code's full prompt | ~3000-5000 |

Every token in the system prompt is paid on every single API call. Minimalism isn't just aesthetic — it's economic.
