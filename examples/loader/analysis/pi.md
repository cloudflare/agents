# Competitive Analysis: pi (pi.dev) vs Think Agent

## Executive Summary

**pi** by Mario Zechner is a **radically minimal** terminal coding agent with an opinionated philosophy: "if I don't need it, it won't be built." It deliberately omits features like sub-agents, plan mode, MCP support, and permissions - arguing these can be built via extensions or aren't needed at all.

**Sources**:

- [https://pi.dev](https://pi.dev/)
- [GitHub](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
- [Blog: Building pi](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)

**Key Insight**: pi represents the **opposite end of the spectrum** from our Think agent. Where we build persistence, isolation, and recovery into the core, pi says "just use files, tmux, and bash." Both approaches work - it's a question of who your users are and what guarantees they need.

---

## Feature Comparison

| Feature                | pi                               | Think Agent                |
| ---------------------- | -------------------------------- | -------------------------- |
| **Deployment**         | Local CLI/TUI                    | Cloudflare Durable Objects |
| **System Prompt**      | ~1000 tokens                     | Larger, feature-rich       |
| **Tools**              | 4 core (read, write, edit, bash) | 13 tools                   |
| **Sub-agents**         | "Use tmux" / extensions          | DO Facets                  |
| **Plan Mode**          | "Write to PLAN.md" / extensions  | Not built-in               |
| **MCP**                | "Build CLI tools instead"        | Via bindings               |
| **Permissions**        | None ("YOLO mode")               | Not yet                    |
| **Todo Lists**         | "Use TODO.md"                    | Task management module     |
| **Background Bash**    | "Use tmux"                       | Not built-in               |
| **Persistence**        | File-based sessions              | SQLite in DO               |
| **Context Compaction** | Manual / extensions              | Planned (Phase 5.7)        |
| **Multi-Provider**     | 15+ providers, custom models     | OpenAI/Anthropic           |
| **Session Branching**  | ✅ Tree-structured               | Not yet                    |
| **Extensions**         | ✅ TypeScript modules            | Class extension            |
| **Skills**             | ✅ Progressive disclosure        | Not implemented            |
| **Streaming**          | ✅ TUI with diff rendering       | WebSocket                  |

---

## Deep Dive: pi Philosophy

### 1. Minimal System Prompt (~1000 tokens)

pi's entire system prompt:

```
You are an expert coding assistant. You help users with coding tasks by
reading files, executing commands, editing code, and writing new files.

Available tools:
- read: Read file contents
- bash: Execute bash commands
- edit: Make surgical edits to files
- write: Create or overwrite files

Guidelines:
- Use bash for file operations like ls, grep, find
- Use read to examine files before editing
- Use edit for precise changes (old text must match exactly)
- Use write only for new files or complete rewrites
- When summarizing your actions, output plain text directly
- Be concise in your responses
- Show file paths clearly when working with files
```

**Rationale**: "Models have been RL-trained up the wazoo, so they inherently understand what a coding agent is. There does not appear to be a need for 10,000 tokens of system prompt."

**Benchmark evidence**: pi with Claude Opus 4.5 placed competitively on Terminal-Bench 2.0 against tools with far larger prompts.

### 2. Minimal Toolset (4 tools)

```
read
- path: Path to file
- offset: Line number to start (1-indexed)
- limit: Maximum lines to read

write
- path: Path to file
- content: Content to write

edit
- path: Path to file
- oldText: Exact text to find
- newText: Replacement text

bash
- command: Command to execute
- timeout: Optional timeout in seconds
```

**Philosophy**: "These four tools are all you need for an effective coding agent."

**Comparison**: Claude Code has ~20 tools with detailed examples. Codex is similarly minimal.

### 3. "What We Didn't Build"

pi explicitly omits features, arguing they're unnecessary or better handled externally:

#### No MCP Support

> "MCP servers are overkill for most use cases. Popular servers like Playwright MCP (21 tools, 13.7k tokens) or Chrome DevTools MCP (26 tools, 18k tokens) dump their entire tool descriptions into context."

**Alternative**: Build CLI tools with README files. The agent reads the README when needed (progressive disclosure) and invokes via bash.

```markdown
# Browser Tools (225 tokens vs 13,700 for MCP)

## Start Chrome

./start.js # Fresh profile
./start.js --profile # Copy your profile

## Navigate

./nav.js https://example.com
./nav.js https://example.com --new

## Evaluate JavaScript

./eval.js 'document.title'

## Screenshot

./screenshot.js
```

#### No Sub-agents

> "You have zero visibility into what that sub-agent does. It's a black box within a black box."

**Alternative**:

1. Spawn pi via bash: `pi --print "review this code"`
2. Use tmux for full observability
3. Build via extensions if needed

> "Using a sub-agent mid-session for context gathering is a sign you didn't plan ahead."

#### No Plan Mode

> "Telling the agent to think through a problem together with you, without modifying files or executing commands, is generally sufficient."

**Alternative**: Write to PLAN.md file. "Unlike ephemeral planning modes, file-based plans can be shared across sessions and versioned with your code."

#### No Permission Popups ("YOLO Mode")

> "As soon as your agent can write code and run code, it's pretty much game over. The only way you could prevent exfiltration would be to cut off all network access."

**Philosophy**: Security measures are "mostly security theater." Run in a container if concerned.

#### No Background Bash

> "Background process management adds complexity. Use tmux instead."

Provides full observability, direct interaction, and a CLI to list sessions.

#### No Built-in To-dos

> "To-do lists generally confuse models more than they help. They add state that the model has to track."

**Alternative**: Use a TODO.md file with checkboxes.

### 4. Architecture

pi is built from four packages:

1. **pi-ai**: Unified LLM API
   - 4 APIs: OpenAI Completions, OpenAI Responses, Anthropic Messages, Google Generative AI
   - Cross-provider context handoff
   - TypeBox schemas for tools
   - Abort support throughout
   - Split tool results (LLM portion vs UI portion)

2. **pi-agent-core**: Agent loop
   - Tool execution and validation
   - Event streaming
   - Message queuing (steering vs follow-up)

3. **pi-tui**: Terminal UI
   - Retained mode components
   - Differential rendering (only redraw changed lines)
   - Synchronized output for flicker-free updates

4. **pi-coding-agent**: The CLI
   - Session management with tree branching
   - AGENTS.md / SYSTEM.md context
   - Extensions, skills, themes
   - Four modes: interactive, print/JSON, RPC, SDK

### 5. Extensions System

Extensions are TypeScript modules with access to:

- Tools
- Commands
- Keyboard shortcuts
- Events
- Full TUI

**Example extensions** (50+ in repo):

- Sub-agents
- Plan mode
- Permission gates
- Path protection
- SSH execution
- Sandboxing
- MCP integration
- Custom editors
- Status bars
- Doom (yes, really)

### 6. Skills (Progressive Disclosure)

Skills are capability packages loaded on-demand:

```markdown
## <!-- ~/.pi/skills/git-release/SKILL.md -->

name: git-release
description: Create consistent releases and changelogs

---

## What I do

- Draft release notes from merged PRs
- Propose a version bump
- Provide a copy-pasteable `gh release create` command
```

Agent loads skill only when needed → saves context tokens.

### 7. Session Management

Sessions stored as **trees**, not linear history:

- Navigate to any point with `/tree`
- Branch from any message
- All branches in single file
- Export to HTML with `/export`
- Share via GitHub gist with `/share`

### 8. Message Queuing

Two modes while agent is working:

- **Enter**: Steering message (interrupts after current tool)
- **Alt+Enter**: Follow-up (waits for agent to finish)

### 9. Context Engineering

pi's philosophy: "Exactly controlling what goes into the model's context yields better outputs."

**Mechanisms**:

- AGENTS.md: Project instructions (hierarchical)
- SYSTEM.md: Replace/append to system prompt
- Skills: On-demand capability loading
- Compaction: Auto-summarize (customizable via extensions)
- Dynamic context: Extensions can inject/filter messages

---

## Key Differentiators

### pi Advantages

1. **Radical Minimalism**: 4 tools, ~1000 token prompt
2. **Full Observability**: No black boxes, everything visible
3. **Session Trees**: Branch from any point in conversation
4. **Progressive Disclosure**: Skills loaded on-demand
5. **CLI Tools > MCP**: More composable, fewer tokens
6. **Message Queuing**: Steer or follow-up while agent works
7. **Extension System**: Build anything yourself
8. **Multi-Provider**: 15+ providers with cross-provider context handoff
9. **Benchmark Performance**: Competitive despite minimal tooling
10. **Philosophy**: Trust the user, skip the guardrails

### Think Agent Advantages

1. **Persistence**: Durable Objects with SQLite
2. **Edge Deployment**: Cloudflare global distribution
3. **Subagent Isolation**: DO Facets with separate storage
4. **Recovery**: Hibernation and orphan detection
5. **WebSocket-First**: Real-time bidirectional
6. **Debug Panel**: Built-in visibility
7. **Browser Automation**: Playwright integration
8. **Yjs Storage**: Collaborative editing foundation
9. **Multi-user Ready**: DO architecture supports sharing
10. **Production Ready**: Built for hosted deployment

---

## Lessons to Learn

### 1. Consider Minimal System Prompt

Our prompt is likely larger than necessary. pi proves competitive with ~1000 tokens.

```typescript
// Could we reduce to essentials?
const MINIMAL_SYSTEM_PROMPT = `
You are an expert coding assistant.

Tools: read, write, edit, bash, listFiles, fetch, webSearch, ...

Guidelines:
- Read before editing
- Edit for precise changes, write for new files
- Be concise
`;
```

### 2. Progressive Disclosure (Skills)

Don't load everything into context. pi's skills pattern:

- Agent sees skill names/descriptions
- Loads full skill only when needed
- Saves context tokens

```typescript
// Instead of 13 tool descriptions always in context:
// - Show summaries
// - Load full descriptions on-demand
```

### 3. Message Queuing UX

pi's steering vs follow-up pattern is elegant:

- **Steer**: Interrupt after current tool
- **Follow-up**: Wait for agent to finish

Could improve our WebSocket UX.

### 4. Session Branching

Tree-structured sessions with navigation:

- Fork from any message
- Explore alternatives
- All in one file

We have message editing → truncate, but full branching could be valuable.

### 5. CLI Tools Pattern

pi's argument against MCP is compelling:

- MCP servers: 13-18k tokens per server
- CLI tools + README: 200-500 tokens
- Agent reads README on-demand
- Uses bash to invoke

Consider for our loopback pattern:

```markdown
<!-- Instead of detailed tool schemas in context -->

## Bash Tool

Execute commands. Examples:

- `ls -la` - list files
- `grep -r "pattern" src/` - search code
- `curl api.example.com` - HTTP requests

Read tool READMEs for complex operations.
```

### 6. YOLO as Default

pi's argument: permissions are "security theater" when agent can execute code.

**Consider**: Our current approach has no permissions. Is that the right default? Or should we add them as safety theater for user confidence?

### 7. Cross-Provider Context Handoff

pi-ai handles switching models mid-session with automatic context transformation:

- Anthropic thinking traces → `<thinking>` tags for OpenAI
- Provider-specific blobs managed automatically

Our multi-model architecture (Phase 5.14) could benefit from this.

---

## Philosophy Comparison

| Aspect          | pi                            | Think Agent           |
| --------------- | ----------------------------- | --------------------- |
| **Target User** | Power users, hackers          | Broader audience      |
| **Deployment**  | Self-hosted CLI               | Cloud-hosted          |
| **State**       | Files, user manages           | DO persistence        |
| **Security**    | "YOLO, use containers"        | Will need permissions |
| **Features**    | Minimal core, extend yourself | Batteries included    |
| **Recovery**    | Manual / tmux                 | Automatic via DO      |
| **Multi-user**  | Single user                   | Multiplayer-ready     |

---

## Recommendations

### Adopt from pi

1. **Minimal Prompt Experiment** - Test reduced system prompt
   - Does 1000 tokens work for us?
   - What's actually necessary?

2. **Progressive Disclosure** - Skills/on-demand loading
   - Don't pay context cost for unused tools
   - Load detailed instructions when needed

3. **Message Queuing** - Steering vs follow-up
   - Better UX during long operations
   - User can redirect or queue

4. **Session Branching** - Tree structure
   - Beyond message editing
   - Full conversation forking

5. **CLI Tools Pattern** - For loopbacks
   - README-based discovery
   - Bash invocation
   - Lower context cost

### Where We Differ

1. **Persistence** - We need it for multi-session, multi-user
2. **Subagent Isolation** - DO Facets are genuinely useful
3. **Permissions** - Likely needed for broader adoption
4. **Recovery** - Users expect it to just work
5. **Hosted Deployment** - Not everyone wants to run locally

### Philosophical Takeaway

pi proves you can build a competitive agent with radical minimalism:

- 4 tools
- 1000 token prompt
- No sub-agents, no MCP, no permissions
- Competitive on benchmarks

This doesn't mean we should copy it. Our users may have different needs:

- Multi-user collaboration
- Production deployment
- Automatic recovery
- Enterprise requirements

But it's a valuable reminder: **complexity has costs**. Every feature we add should justify its context tokens and cognitive load.

---

## Conclusion

pi is a **refreshing counterpoint** to feature-bloated agents. Mario Zechner built exactly what he needs and nothing more. The philosophy is:

1. Models are smart enough without massive prompts
2. Files + bash solve most "features"
3. Extensions let power users build what they need
4. Security theater isn't security
5. Observability > hidden complexity

Our Think agent serves a different audience (cloud-hosted, multi-user, production-ready), but we can learn from pi's minimalism:

- **Question every feature's context cost**
- **Progressive disclosure saves tokens**
- **Observability matters**
- **Sometimes "use a file" is the right answer**

The most actionable insight: **try reducing our system prompt and tool descriptions**. If pi can compete on benchmarks with 1000 tokens, we're probably over-prompting.

---

_Analysis date: February 2026_
