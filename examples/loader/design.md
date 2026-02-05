# Cloud-Native Coding Agent Runtime

## Implementation Status

| Component         | Status      | Notes                                         |
| ----------------- | ----------- | --------------------------------------------- |
| Coder Agent (DO)  | ✅ Complete | Full Agent class with state, SQL, WebSocket   |
| LOADER Execution  | ✅ Complete | Dynamic worker loading with harness           |
| Loopback Pattern  | ✅ Complete | EchoLoopback, BashLoopback, FSLoopback        |
| Timeouts & Errors | ✅ Complete | Configurable timeout, error categorization    |
| Yjs Storage       | ✅ Complete | SQLite persistence, versioning, snapshots     |
| File Operations   | ✅ Complete | read/write/edit/delete via Yjs                |
| just-bash         | ✅ Complete | Shell commands in isolates                    |
| In-memory FS      | ✅ Complete | Scratch space for temp files                  |
| WebSocket Sync    | ⚡ Partial  | Binary broadcast, needs full Yjs protocol     |
| Controlled Fetch  | ✅ Complete | URL/method allowlist, request logging         |
| LLM Integration   | ✅ Complete | GPT-4o, 6 tools, auto tool loop, chat history |
| UI                | ❌ Planned  | Chat, code editor, status                     |
| Sandbox           | ❌ Planned  | Full VM for heavy workloads                   |

---

## Overview

This project implements a **cloud-native coding agent runtime** built on Cloudflare's infrastructure. It enables AI agents to write, execute, and iterate on code in a secure, isolated environment—similar to what local coding agents like Pi, OpenClaw, and Claude Code do on a developer's machine, but running entirely on the edge.

The core insight: **coding agents are replacing agent frameworks**. Instead of orchestrating tools through structured APIs, agents that can read/write files and execute code can accomplish almost anything. This project brings that capability to Cloudflare Workers.

## Inspiration

### Pi (pi.dev)

- Minimal core: just 4 tools (Read, Write, Edit, Bash)
- Self-modifying: agent can extend itself by writing extensions
- Hot reloading: changes take effect immediately
- Sessions are trees: can branch, rewind, navigate history

### OpenClaw (openclaw.ai)

- Personal AI assistant that runs on your machine
- Can pull down skills and tools dynamically
- Connected to communication channels (Telegram, Discord, etc.)
- Celebrates "code writing code"

### Minions (AI Gadgets)

- Overseer pattern: supervisor DO that loads Gadget code via LOADER
- Gatekeeper pattern: security boundary for external APIs
- Yjs for code storage: CRDT-based, real-time collaborative editing
- Loopback bindings: pass capabilities to dynamic workers via ctx.exports
- Human-in-the-loop: action approval queue

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     Coder Agent (Durable Object)                        │
│                     extends Agent<Env, CoderState>                      │
│                                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌───────────────┐  │
│  │   State     │  │   SQLite    │  │  Scheduler  │  │   WebSocket   │  │
│  │ this.state  │  │  this.sql   │  │this.schedule│  │  onMessage()  │  │
│  │             │  │             │  │             │  │  onConnect()  │  │
│  │ - session   │  │ - chat log  │  │ - timeouts  │  │               │  │
│  │ - files     │  │ - versions  │  │ - cron jobs │  │  Real-time    │  │
│  │ - context   │  │ - actions   │  │ - reminders │  │  chat & sync  │  │
│  └─────────────┘  └─────────────┘  └─────────────┘  └───────────────┘  │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                        Yjs Document                              │   │
│  │  Y.Map<Y.Text> mapping filenames → content                       │   │
│  │  - Full version history                                          │   │
│  │  - Real-time multiplayer sync                                    │   │
│  │  - Merge/revert support                                          │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                     Loopback Bindings                            │   │
│  │  ctx.exports.BashLoopback({props})   → just-bash execution       │   │
│  │  ctx.exports.FSLoopback({props})     → worker-fs-mount ops       │   │
│  │  ctx.exports.FetchLoopback({props})  → controlled network        │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                    env.LOADER.get(id, () => WorkerCode)
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Dynamic Worker (Isolate)                             │
│                                                                         │
│  Loaded via LOADER binding with:                                        │
│  - mainModule: entry point                                              │
│  - modules: { "file.js": "code..." }                                    │
│  - env: loopback bindings to parent                                     │
│  - globalOutbound: null (no direct network)                             │
│                                                                         │
│  Characteristics:                                                       │
│  - Ephemeral: can be evicted at any time                               │
│  - Sandboxed: only access what we explicitly provide                    │
│  - Fast: millisecond cold starts                                        │
│  - Cached: same ID may reuse warm isolate                              │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                    When isolates aren't enough...
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Cloudflare Sandbox (VM)                              │
│                                                                         │
│  Full Linux environment for heavy operations:                           │
│  - Binary execution (ffmpeg, python, etc.)                              │
│  - Real filesystem operations                                           │
│  - Long-running processes                                               │
│  - Could even run another coding agent (opencode, etc.)                │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Key Patterns

### 1. The Loopback Binding Pattern

Dynamic workers loaded via LOADER can't receive RpcStubs directly. Instead, we pass ServiceStubs that "loop back" through ctx.exports:

```typescript
// In the Coder Agent
getEnvForLoader(): Record<string, Fetcher> {
  return {
    BASH: this.ctx.exports.BashLoopback({ props: { sessionId: this.sessionId } }),
    FS: this.ctx.exports.FSLoopback({ props: { sessionId: this.sessionId } }),
    // ... other tools
  };
}

// BashLoopback is a WorkerEntrypoint that proxies to just-bash
export class BashLoopback extends WorkerEntrypoint<Env, LoopbackProps> {
  async exec(command: string): Promise<BashResult> {
    // Access the bash instance via the parent Agent
    // props.sessionId identifies which session this belongs to
    return this.runBashCommand(command);
  }
}
```

### 2. Yjs for Code Storage

Code is stored as a Yjs document, enabling:

- **Version history**: Every change is tracked
- **Multiplayer editing**: Human and agent can edit simultaneously
- **Branching**: Proposed changes can be tested before merge
- **Conflict resolution**: CRDTs handle concurrent edits

Structure:

```
Y.Doc
└── Y.Map<Y.Text> (root)
    ├── "server.js" → Y.Text("export default { ... }")
    ├── "client.js" → Y.Text("const app = ... ")
    └── "README.md" → Y.Text("# My Project")
```

Version IDs include code version: `{agentId}.{codeVersion}` so code changes create new isolates.

### 3. Ephemeral vs Persistent Execution

**Ephemeral (one-off)**: For tool calls, quick computations

- Random ID: `LOADER.get(crypto.randomUUID(), ...)`
- No state preservation
- Used for: bash commands, code evaluation, tool execution

**Persistent (session-based)**: For running applications

- Stable ID: `LOADER.get(`${agentId}.${version}`, ...)`
- May reuse warm isolate
- Used for: running the user's Gadget/app

### 4. The Continuation Model (for Human-in-the-Loop)

When the agent needs to wait (user approval, external event, timer), it saves a **continuation**:

```typescript
interface Continuation {
  // What are we waiting for?
  waitingFor:
    | { type: "user_input"; prompt: string; schema?: JSONSchema }
    | { type: "approval"; action: ActionDescription }
    | { type: "webhook"; path: string }
    | { type: "timer"; at: Date };

  // Context to restore
  context: {
    conversationId: string;
    localState: Record<string, any>;
  };

  // What to do when resumed
  resumeWith: string;
}
```

When the event arrives, the Agent:

1. Loads the continuation from SQLite
2. Spins up a new dynamic worker
3. Provides: conversation history + continuation context + new event
4. Agent continues reasoning

## Security Model

### Isolation Layers

1. **Dynamic Worker Isolation**
   - `globalOutbound: null` blocks all network access
   - Only access to explicitly provided `env` bindings
   - Cannot access parent's storage directly

2. **Loopback Control**
   - Each tool binding can enforce its own security
   - Bash: execution limits, command filtering
   - FS: path restrictions, quota limits
   - Fetch: URL allowlists, method restrictions

3. **Action Approval** (Future)
   - Side-effecting actions can require human approval
   - Audit log of all actions
   - Revert capability for applied actions

### What Dynamic Workers CAN Access

- Tools we explicitly provide via env bindings
- Code modules we load into the isolate
- Cloudflare APIs available in Workers (crypto, etc.)

### What Dynamic Workers CANNOT Access

- The internet (globalOutbound: null)
- Parent Agent's storage
- Other Durable Objects
- Secrets/environment variables (unless passed)

## Tools

### Core Tools (Phase 3)

| Tool      | Implementation      | Purpose                              |
| --------- | ------------------- | ------------------------------------ |
| **bash**  | just-bash           | Shell commands in virtual FS         |
| **fs**    | worker-fs-mount     | File operations (read, write, mkdir) |
| **fetch** | Controlled loopback | HTTP requests with allowlist         |

### Extended Tools (Future)

| Tool           | Implementation         | Purpose                             |
| -------------- | ---------------------- | ----------------------------------- |
| **sandbox**    | Cloudflare Sandbox SDK | Full VM when isolates aren't enough |
| **web_search** | Search API             | Find information online             |
| **browser**    | Browser Rendering      | Web automation                      |

### Agent Tools (Phase 4)

These are the tools exposed to the LLM:

```typescript
tools: {
  readFile: tool({
    description: "Read a file from the workspace",
    inputSchema: z.object({ path: z.string() }),
    execute: ({ path }) => fs.readFile(path, 'utf8'),
  }),

  writeFile: tool({
    description: "Write content to a file",
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    execute: ({ path, content }) => fs.writeFile(path, content),
  }),

  bash: tool({
    description: "Execute a bash command",
    inputSchema: z.object({ command: z.string() }),
    execute: ({ command }) => bash.exec(command),
  }),

  // ... more tools
}
```

## State Management

### Agent State (this.state)

Synced to connected clients via WebSocket:

```typescript
interface CoderState {
  // Current session
  sessionId: string;

  // What's the agent doing?
  status: "idle" | "thinking" | "executing" | "waiting";

  // Current file being edited (for UI focus)
  activeFile?: string;

  // Pending continuation (if waiting)
  pendingContinuation?: Continuation;
}
```

### SQLite Storage (this.sql)

Persistent data:

```sql
-- Conversation history
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT,
  role TEXT,  -- 'user' | 'assistant' | 'tool'
  content TEXT,
  tool_calls JSON,
  timestamp DATETIME
);

-- Code versions (Yjs snapshots)
CREATE TABLE code_versions (
  version INTEGER PRIMARY KEY,
  timestamp DATETIME,
  update BLOB  -- Yjs encoded update
);

-- Action log
CREATE TABLE actions (
  id INTEGER PRIMARY KEY,
  type TEXT,  -- 'observation' | 'action'
  description JSON,
  state TEXT,  -- 'pending' | 'approved' | 'rejected'
  created_at DATETIME,
  applied_at DATETIME
);
```

## Client Integration

### React Hook

```tsx
import { useAgent } from "agents/react";

function CoderInterface() {
  const [messages, setMessages] = useState([]);

  const agent = useAgent({
    agent: "coder",
    name: sessionId,
    onMessage: (msg) => {
      const data = JSON.parse(msg.data);
      if (data.type === "chat") {
        setMessages((prev) => [...prev, data.message]);
      }
    },
    onStateUpdate: (state) => {
      // State synced from Agent
    }
  });

  const sendMessage = (content: string) => {
    agent.send(JSON.stringify({ type: "chat", content }));
  };

  return (
    <div>
      <ChatPanel messages={messages} onSend={sendMessage} />
      <CodeEditor yDoc={yDoc} /> {/* Yjs-synced editor */}
    </div>
  );
}
```

### Yjs Sync

The Yjs document syncs via WebSocket alongside chat:

```typescript
// In the Agent
onMessage(connection, message) {
  const data = JSON.parse(message);

  if (data.type === "yjs-update") {
    // Apply client's Yjs update
    Y.applyUpdateV2(this.yDoc, data.update);
    // Broadcast to other clients
    this.broadcast(message, [connection]);
  }

  if (data.type === "chat") {
    // Handle chat message, potentially trigger agent
  }
}
```

## Future: Skills Registry

_Parked for later implementation_

The architecture is designed to support a skills registry where:

- Skills are reusable code+prompt packages
- Agent can discover and load skills on demand
- Skills can be shared across sessions
- Skills can be auto-generated by the agent

This would extend the `modules` passed to LOADER:

```typescript
modules: {
  "main.js": mainCode,
  "skill-web-search.js": await loadSkill("web-search"),
  "skill-git.js": await loadSkill("git-operations"),
  // ...
}
```

## References

- [Cloudflare Worker Loader API](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/)
- [Cloudflare Sandbox SDK](https://developers.cloudflare.com/sandbox/)
- [Cloudflare Agents SDK](https://developers.cloudflare.com/agents)
- [Pi Coding Agent](https://pi.dev/)
- [OpenClaw](https://openclaw.ai/)
- [just-bash](https://github.com/vercel-labs/just-bash)
- [worker-fs-mount](https://github.com/danlapid/worker-fs-mount)
- [Yjs](https://docs.yjs.dev/)
