# Think App

## Architecture

```
┌─────────────────────────────────┐
│           think-cli             │
│                                 │
│  Local config (~/.think/)       │
│  User input (pi-tui)           │
│  Render server responses       │
│  Callables for API actions     │
│  Messages for everything else  │
│                                 │
│  Nothing else happens here.    │
└──────────────┬──────────────────┘
               │ WebSocket (native)
               │ cf_agent_chat_* protocol
               │ + callables (configure, etc.)
               │
┌──────────────▼──────────────────┐
│         think-server            │
│     ThinkServer extends Think   │
│                                 │
│  ┌───────────────────────────┐  │
│  │ Agent Loop (streamText)   │  │
│  │ Model: Workers AI or BYOM │  │
│  │ Config from CLI, saved    │  │
│  │ via Think.configure()     │  │
│  └───────────────────────────┘  │
│                                 │
│  ┌───────────────────────────┐  │
│  │ Session Memory            │  │
│  │ (Think SessionManager)    │  │
│  │ Branching, compaction     │  │
│  └───────────────────────────┘  │
│                                 │
│  ┌───────────────────────────┐  │
│  │ Workspace (SQLite + R2)   │  │
│  │ read/write/edit/find/grep │  │
│  └───────────────────────────┘  │
│                                 │
│  ┌───────────────────────────┐  │
│  │ Code Tool (codemode)      │  │
│  │ Dynamic V8 isolates       │  │
│  │ via WorkerLoader          │  │
│  └───────────────────────────┘  │
│                                 │
│  ┌───────────────────────────┐  │
│  │ Memory (open question)    │  │
│  │ Context memory?           │  │
│  │ Long-term memory?         │  │
│  └───────────────────────────┘  │
│                                 │
└─────────────────────────────────┘
```

## CLI (think-cli)

Pure rendering client. Responsibilities:

1. **Load local config** — `~/.think/config.json` (provider, model, API key)
2. **Connect to server** — WebSocket to `/agents/think-server/<session>`
3. **Send config** — via callable `configure({ provider, model, apiKey })`
4. **Accept user input** — pi-tui Editor component
5. **Render responses** — pi-tui Markdown, Loader, Text components
6. **Show tool activity** — render tool calls and results as they stream

Does NOT:
- Call any model APIs
- Execute any tools
- Manage sessions/memory
- Run any business logic

### Config

```json
// ~/.think/config.json
{
  "server": "ws://localhost:8787",
  "provider": "anthropic",
  "model": "claude-opus-4-6",
  "apiKey": "sk-ant-..."
}
```

API key resolution order:
1. `~/.think/config.json` apiKey
2. `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` env vars
3. OpenCode auth (`~/.local/share/opencode/auth.json`)

### Modes

- **Interactive** — pi-tui, streaming, full chat
- **Print** (`-p`) — one-shot, text to stdout, exit
- **JSON** (`--mode json`) — one-shot, events as JSONL to stdout

## Server (think-server)

`ThinkServer extends Think<Env, ModelConfig>`. All execution happens here.

### Model Providers

Config received from CLI via callable, saved in Think's SQLite config:

```typescript
interface ModelConfig {
  provider: "anthropic" | "openai" | "workers-ai";
  model: string;
  apiKey?: string;
  // For gateway proxies (opencode.cloudflare.dev)
  baseUrl?: string;
  headers?: Record<string, string>;
}
```

`getModel()` reads config and creates the appropriate AI SDK provider:
- `@ai-sdk/anthropic` for Anthropic (direct or via gateway)
- `@ai-sdk/openai` for OpenAI
- `workers-ai-provider` for Workers AI (default, no key needed)

### Tools

Workspace tools from `@cloudflare/think/tools/workspace`:
- read_file, write_file, edit_file, list_directory, find_files, grep, delete

Code execution from `@cloudflare/think/tools/execute`:
- `createExecuteTool({ tools, loader: env.LOADER })`
- LLM writes JS → runs in dynamic V8 isolate → results back

Memory tools (remember/recall) — TBD pending schema compat fix.

### Session Memory

Think's built-in SessionManager:
- Tree-structured messages with branching
- Compaction for long conversations
- Multiple named sessions
- SQLite-backed, survives hibernation

### WebSocket Protocol

All native `cf_agent_chat_*`:
- `cf_agent_use_chat_request` — CLI sends user message
- `cf_agent_use_chat_response` — server streams chunks (text, tool calls, tool results)
- `cf_agent_chat_messages` — server sends full history on connect
- `cf_agent_chat_clear` — clear session
- `cf_agent_chat_request_cancel` — abort

Plus callables via DO RPC:
- `configure(config)` — set model provider/key
- `getConfig()` — read current config

## Open Questions

### Context Memory
How to manage what gets sent to the model each turn. Think has `assembleContext()` as the override point. Options:
- Prune old tool calls (current default)
- Inject project context / RAG
- Compaction summaries for long conversations

### Long-term Memory
Facts that persist across sessions. Options:
- Separate SQLite table (like experimental Session memory)
- remember/recall tools (need schema fix)
- Auto-extract from conversations
- Vector search for relevance

## Inspiration

- **OpenCode** — provider system, gateway auth, print mode
- **Pi Agent** (pi-mono) — TUI components, extension system, streaming architecture
- **Claude Code** — system prompt, memory system, tool patterns
