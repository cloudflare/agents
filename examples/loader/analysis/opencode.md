# Competitive Analysis: OpenCode vs Think Agent

## Executive Summary

**OpenCode** is an open-source AI coding agent available as a TUI, web app, and IDE extension. It's built by Anomaly and has strong community adoption. It's a **direct competitor** to our Think agent but targets a different deployment model (local CLI vs. Cloudflare Durable Objects).

**Source**: [https://opencode.ai/docs](https://opencode.ai/docs)

---

## Feature Comparison

| Feature               | OpenCode                      | Think Agent                           |
| --------------------- | ----------------------------- | ------------------------------------- |
| **Deployment**        | Local CLI/TUI, web server     | Cloudflare Durable Objects (hosted)   |
| **State Persistence** | Local SQLite                  | DO SQLite + hibernation               |
| **Multi-Provider**    | 75+ providers via AI SDK      | OpenAI/Anthropic (extensible planned) |
| **Tools**             | 15 built-in                   | 13 built-in                           |
| **Custom Tools**      | TypeScript/JS definitions     | Via class extension                   |
| **Subagents**         | ✅ General + Explore          | ✅ DO Facets                          |
| **MCP Support**       | ✅ Local + Remote + OAuth     | ✅ Via bindings                       |
| **Skills/Rules**      | AGENTS.md + SKILL.md          | Props-based instructions              |
| **Permissions**       | Granular (allow/ask/deny)     | Not yet implemented                   |
| **Streaming**         | ✅ SSE + WebSocket            | ✅ WebSocket                          |
| **Web UI**            | ✅ (`opencode web`)           | ✅ Vite React                         |
| **Undo/Redo**         | ✅ Built-in                   | Not yet                               |
| **Message Editing**   | Not documented                | ✅ Implemented                        |
| **Session Sharing**   | ✅ `/share` command           | Not yet                               |
| **SDK**               | `@opencode-ai/sdk` TypeScript | `agents/react` hook                   |
| **Multiplayer**       | Not documented                | Planned (Phase 8)                     |

---

## Deep Dive: OpenCode Architecture

### 1. Agent System

OpenCode has a sophisticated **primary agents + subagents** model:

**Primary Agents** (user-facing, cycle with Tab):

- **Build** - Full tool access, default agent
- **Plan** - Read-only, analysis mode (like our debug panel concept)

**Subagents** (invoked by primary agents or `@mention`):

- **General** - Full tool access for parallel work
- **Explore** - Read-only, fast codebase exploration

**System Agents** (hidden):

- **Compaction** - Summarizes long context automatically
- **Title** - Generates session titles
- **Summary** - Creates session summaries

This is similar to our `Think` + Subagent (via Facets) model, but they've clearly productionized the "different agents for different tasks" pattern.

### 2. Built-in Tools

| Tool                   | Description              | Our Equivalent         |
| ---------------------- | ------------------------ | ---------------------- |
| `bash`                 | Shell execution          | `bash`                 |
| `read`                 | File reading             | `readFile`             |
| `write`                | File creation            | `writeFile`            |
| `edit`                 | String replacement       | `editFile`             |
| `patch`                | Apply diffs              | Not implemented        |
| `multiedit`            | Multiple edits           | Not implemented        |
| `grep`                 | Regex search             | (via bash)             |
| `glob`                 | File pattern matching    | (via bash)             |
| `list`                 | Directory listing        | `listFiles`            |
| `webfetch`             | HTTP requests            | `fetch`                |
| `todowrite`/`todoread` | Task tracking            | Task management module |
| `skill`                | Load skill definitions   | Not implemented        |
| `question`             | Ask user questions       | Not implemented        |
| `lsp` (experimental)   | Language server protocol | Not implemented        |

**Key difference**: They use `ripgrep` under the hood for search tools, respecting `.gitignore`.

### 3. Permissions System

OpenCode has a **granular permission system** that's more mature than ours:

```json
{
  "permission": {
    "*": "ask", // Default: prompt for everything
    "bash": {
      "*": "ask",
      "git *": "allow", // Allow all git commands
      "rm *": "deny" // Block rm commands
    },
    "edit": {
      "*.env": "deny" // Protect env files
    },
    "external_directory": {
      "~/projects/*": "allow" // Allow access outside cwd
    }
  }
}
```

Three permission levels: `allow`, `ask`, `deny`

**Notable features**:

- Wildcard patterns with `*` and `?`
- Home directory expansion (`~`, `$HOME`)
- `doom_loop` detection (same tool call 3x = prompt)
- Per-agent permission overrides

### 4. Custom Tools

OpenCode allows custom tools via TypeScript/JavaScript:

```typescript
// .opencode/tools/database.ts
import { tool } from "@opencode-ai/plugin";

export default tool({
  description: "Query the project database",
  args: {
    query: tool.schema.string().describe("SQL query to execute")
  },
  async execute(args, context) {
    // context includes: agent, sessionID, messageID, directory, worktree
    return `Executed query: ${args.query}`;
  }
});
```

This solves the **"Custom Tools via Props"** challenge we've been wrestling with (Phase 5.15). They use a file-based approach where tool definitions are TypeScript files that get loaded.

### 5. Skills System (SKILL.md)

Skills are reusable instruction sets that agents can load on-demand:

```markdown
---
name: git-release
description: Create consistent releases and changelogs
---

## What I do

- Draft release notes from merged PRs
- Propose a version bump
- Provide a copy-pasteable `gh release create` command
```

**Discovery locations**:

- `.opencode/skills/<name>/SKILL.md`
- `~/.config/opencode/skills/<name>/SKILL.md`
- Claude-compatible: `.claude/skills/`, `.agents/skills/`

This is similar to our planned props-based instructions but more structured.

### 6. MCP Integration

Comprehensive MCP support with:

**Local MCP servers**:

```json
{
  "mcp": {
    "my-local-mcp": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-everything"],
      "environment": { "MY_VAR": "value" }
    }
  }
}
```

**Remote MCP servers with OAuth**:

```json
{
  "mcp": {
    "sentry": {
      "type": "remote",
      "url": "https://mcp.sentry.dev/mcp",
      "oauth": {}
    }
  }
}
```

They even support OAuth auto-detection and Dynamic Client Registration (RFC 7591).

### 7. SDK & API

Full TypeScript SDK with typed client:

```typescript
import { createOpencode } from "@opencode-ai/sdk";

const { client } = await createOpencode();

// Session management
const session = await client.session.create({ body: { title: "My session" } });

// Send prompts
const result = await client.session.prompt({
  path: { id: session.id },
  body: {
    model: { providerID: "anthropic", modelID: "claude-3-5-sonnet" },
    parts: [{ type: "text", text: "Hello!" }]
  }
});

// Server-sent events
const events = await client.event.subscribe();
for await (const event of events.stream) {
  console.log(event.type, event.properties);
}
```

### 8. Rules/Instructions System

Multiple layers of project context:

1. **AGENTS.md** - Project root (committed to git)
2. **~/.config/opencode/AGENTS.md** - Global personal rules
3. **opencode.json `instructions`** - Additional files via glob patterns
4. **Claude Code compatibility** - `CLAUDE.md`, `.claude/` directories

### 9. Context Compaction

Automatic context management:

```json
{
  "compaction": {
    "auto": true, // Auto-compact when context full
    "prune": true // Remove old tool outputs
  }
}
```

Uses a dedicated `compaction` agent with a summarizer model.

---

## Key Differentiators

### OpenCode Advantages

1. **Multi-Provider Support**: 75+ providers out of the box via AI SDK + models.dev
2. **Granular Permissions**: Mature allow/ask/deny system with pattern matching
3. **Custom Tools File-Based**: Clean solution for extensibility
4. **MCP OAuth**: Full OAuth support for remote MCP servers
5. **Undo/Redo**: Built-in rollback for agent changes
6. **Session Sharing**: One-click share conversations
7. **Plan Mode**: Built-in read-only analysis agent
8. **LSP Integration**: Experimental but available (go-to-definition, etc.)
9. **Mature CLI/TUI**: Polished terminal experience

### Think Agent Advantages

1. **Cloudflare Native**: Runs on edge, hibernation, global distribution
2. **WebSocket-First**: Real-time collaboration potential
3. **Durable Objects**: Built-in persistence, no local state needed
4. **Subagent Isolation**: DO Facets provide true isolation
5. **Message Editing**: Edit and fork from any point in history
6. **Debug Panel**: Real-time visibility into agent internals
7. **Browser Automation**: Playwright integration built-in
8. **Yjs Code Storage**: Versioned, collaborative code editing foundation

---

## Lessons to Learn

### 1. Permission System

OpenCode's granular permissions should be a priority for Think:

```typescript
// Consider adopting similar pattern
permission: {
  bash: { "git *": "allow", "rm *": "deny" },
  edit: { "*.env": "deny" }
}
```

### 2. Custom Tools Approach

Their file-based tool loading solves our serialization problem elegantly:

- Tools are `.ts` files in `.opencode/tools/`
- No need to pass functions through props
- Natural integration with the project

### 3. Plan Mode

A read-only "Plan" agent is valuable for:

- Analysis without risk
- Code review
- Architecture exploration

### 4. Skills System

SKILL.md files provide:

- Reusable instruction sets
- On-demand loading (only when needed)
- Permission controls per skill

### 5. Compaction Agent

Dedicated agent for context summarization is cleaner than inline logic.

### 6. Undo/Redo

Essential for user confidence - they can always roll back.

---

## Architecture Comparison

| Aspect     | OpenCode      | Think Agent             |
| ---------- | ------------- | ----------------------- |
| Runtime    | Node.js (Bun) | Cloudflare Workers      |
| State      | Local SQLite  | DO SQLite               |
| Sessions   | File-based    | Durable Object per user |
| Subagents  | Same process  | Separate DO Facets      |
| Tools      | Plugin files  | Class methods           |
| Streaming  | SSE + WS      | WebSocket               |
| Deployment | Self-hosted   | Cloudflare edge         |

---

## Recommendations for Think Agent

### High Priority (Adopt from OpenCode)

1. **Granular Permissions** - Add to Phase 5.13 (Extensibility)
   - Pattern-based allow/ask/deny
   - Per-tool rules (especially bash)
   - External directory restrictions

2. **Plan/Build Mode Toggle** - Add read-only agent variant
   - Disable write tools
   - Useful for analysis, code review

3. **Undo/Redo** - Essential UX feature
   - Track file state before/after each agent action
   - Allow rollback to any point

4. **File-Based Custom Tools** - Solve Phase 5.15
   - `.think/tools/` directory
   - TypeScript/JavaScript definitions
   - Runtime loading

### Medium Priority

5. **Skills System** - SKILL.md equivalent
   - On-demand instruction loading
   - Per-agent skill permissions

6. **grep/glob Tools** - Native search tools
   - Use ripgrep if available
   - Respect .gitignore

7. **Context Compaction Agent** - Dedicated summarizer
   - Automatic when context full
   - Pruning old tool outputs

### Lower Priority

8. **Session Sharing** - Share conversation links
9. **LSP Integration** - Code intelligence
10. **MCP OAuth** - Full OAuth flow for remote servers

---

## Conclusion

OpenCode is a **mature, well-designed competitor** that has productionized many features we're planning. Their local-first approach complements our cloud-first Durable Objects model - there's room for both paradigms.

The most actionable insights are:

1. **Permission system** - Copy their pattern-based approach
2. **Custom tools via files** - Solves our serialization challenge
3. **Plan mode** - Read-only agent is genuinely useful
4. **Undo/Redo** - Table stakes for user trust

Their multi-provider support (75+) and MCP OAuth are impressive but may be less critical for our cloud-native use case where we control the environment.

---

_Analysis date: February 2026_
