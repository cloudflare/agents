# Multi-chat Applications

> **Experimental.** The API surface may evolve before Think graduates out of
> experimental.

A ChatGPT-style app gives each user a sidebar of conversations. With Think, you
build this as a composition of Durable Objects rather than a mode inside one
agent:

- one **directory** Durable Object per user, which owns the chat list and every
  resource that should be shared across that user's chats;
- one **Think** Durable Object per conversation, which owns that conversation's
  messages, memory, extensions, and branch history.

A Think instance holds exactly one conversation. Putting every conversation in
one Durable Object would serialize all of a user's turns on one single-threaded
object, so each chat gets its own.

This guide walks through the pattern as implemented in
[`examples/assistant`](https://github.com/cloudflare/agents/tree/main/examples/assistant),
the reference Think app. The code below is taken from that example.

> **Topology note.** `examples/assistant` hosts each chat as a facet (a
> [dynamic agent](https://github.com/cloudflare/agents/blob/main/docs/agents/sub-agents.md))
> of the directory, using `subAgent()`, `hasSubAgent()`, `listSubAgents()`,
> and `deleteSubAgent()`. Those methods still work but are deprecated aliases
> for `this.dynamicAgents`. For an open-ended set of long-lived chats, the Agents
> SDK now recommends one top-level Durable Object per chat behind a per-user
> hub — see
> [Routing to independent Agents](https://github.com/cloudflare/agents/blob/main/docs/agents/routing.md#routing-to-independent-agents)
> and [`examples/next/routing`](https://github.com/cloudflare/agents/tree/main/examples/next/routing).
> The ownership split in this guide (what lives on the directory and what lives
> on each chat) is the same in both topologies; only the routing and the
> child-to-parent lookup differ. See [Known limits](#known-limits).

## Architecture

```text
Browser tab
  ├── WebSocket → AssistantDirectory ("alice")    one per signed-in user
  │                 - chat list (sidebar state)
  │                 - shared Workspace
  │                 - shared MCP servers, OAuth tokens, connections
  │                 - cross-chat scheduled work
  │
  └── WebSocket → MyAssistant [chat-abc]          one Think DO per conversation
                    - messages and branches
                    - memory and other context blocks
                    - extensions, config, skills
                    - SharedWorkspace / SharedMCPClient proxies → directory
```

The browser keeps two connections open: one to the directory for the sidebar,
the shared file browser, and MCP state, and one to the active chat for the
conversation itself.

| Resource                                        | Owner     | How chats reach it                              |
| ----------------------------------------------- | --------- | ----------------------------------------------- |
| Chat list, titles, previews                     | Directory | Chats push updates over Durable Object RPC      |
| Workspace files                                 | Directory | `SharedWorkspace` proxy, one RPC per file call  |
| MCP registry, OAuth tokens, live connections    | Directory | `SharedMCPClient` proxy, merged in `beforeTurn` |
| Cross-chat scheduled work                       | Directory | Directory RPCs into the selected chat           |
| Messages, branches, compaction                  | Chat      | Local Session                                   |
| Memory and other context blocks                 | Chat      | Local `configureContext()`                      |
| Extensions, `configure()` config, loaded skills | Chat      | Local Durable Object storage                    |
| Client-side tools and approvals                 | Chat      | The chat WebSocket                              |

## Define the directory

The directory in the example extends `Think` so it can declare a scheduled
task with `getScheduledTasks()`. Its own chat machinery stays dormant: clients
talk to the per-chat agents, not to the directory. The other APIs it uses —
sub-agent management, `onBeforeSubAgent`, `addMcpServer()`, `setState()`, and
`@callable()` — come from `Agent`.

```typescript
import { callable } from "agents";
import { Think, Workspace } from "@cloudflare/think";
import { nanoid } from "nanoid";
import { MyAssistant } from "./agents/my-assistant/agent";

export class AssistantDirectory extends Think<Env, DirectoryState> {
  initialState: DirectoryState = { chats: [] };

  // Required by Think; nothing in the directory role calls it.
  override getModel() {
    return "@cf/moonshotai/kimi-k2.7-code";
  }

  onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS chat_meta (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      last_message_preview TEXT
    )`;
    this._refreshState();
  }
}
```

`DirectoryState` is the sidebar state broadcast to every connected tab:

```typescript
export interface ChatSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastMessagePreview?: string;
}

export interface DirectoryState {
  chats: ChatSummary[];
}
```

## Create, list, rename, and delete chats

The set of chats that exist is owned by the sub-agent registry, which
`subAgent()` and `deleteSubAgent()` keep in lockstep with the actual children.
The `chat_meta` table only decorates registry entries with a title and preview.
If the two disagree, the registry wins.

```typescript
export class AssistantDirectory extends Think<Env, DirectoryState> {
  @callable()
  async createChat(opts?: { title?: string }): Promise<ChatSummary> {
    const id = nanoid(10);
    const now = Date.now();
    const title = opts?.title?.trim() || defaultChatTitle(now);

    // Spawn the child first so the registry is populated.
    await this.subAgent(MyAssistant, id);
    this.sql`
      INSERT INTO chat_meta (id, title, updated_at, last_message_preview)
      VALUES (${id}, ${title}, ${now}, NULL)
    `;
    this._refreshState();
    return { id, title, createdAt: now, updatedAt: now };
  }

  @callable()
  async deleteChat(id: string): Promise<void> {
    // Idempotent: safe for an id that is already gone.
    await this.deleteSubAgent(MyAssistant, id);
    this.sql`DELETE FROM chat_meta WHERE id = ${id}`;
    this._refreshState();
  }

  private _refreshState() {
    const registry = this.listSubAgents(MyAssistant);
    const metaRows = this.sql<{
      id: string;
      title: string;
      updated_at: number;
      last_message_preview: string | null;
    }>`SELECT id, title, updated_at, last_message_preview FROM chat_meta`;
    const metaById = new Map(metaRows.map((row) => [row.id, row]));

    const chats: ChatSummary[] = registry
      .map((entry) => {
        const meta = metaById.get(entry.name);
        return {
          id: entry.name,
          title: meta?.title ?? defaultChatTitle(entry.createdAt),
          createdAt: entry.createdAt,
          updatedAt: meta?.updated_at ?? entry.createdAt,
          lastMessagePreview: meta?.last_message_preview ?? undefined
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);

    this.setState({ ...this.state, chats });
  }
}
```

`renameChat(id, title)` is another `@callable()` method that upserts the
`chat_meta` row and calls `_refreshState()`. Because the sidebar is agent state,
every tab connected to the directory sees creates, renames, and deletes
immediately.

### Keep the sidebar preview current

Each chat reports back to its directory after every turn from
`onChatResponse`, using the typed `parentAgent()` stub:

```typescript
export class MyAssistant extends Think<Env> {
  async onChatResponse(result: ChatResponseResult): Promise<void> {
    const preview = result.message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("")
      .slice(0, 120);
    if (!preview) return;

    try {
      const directory = await this.parentAgent(AssistantDirectory);
      await directory.recordChatTurn(this.name, preview);
    } catch (err) {
      console.warn("[MyAssistant] Failed to update directory preview:", err);
    }
  }
}
```

`recordChatTurn()` on the directory updates `chat_meta` and refreshes state. It
is deliberately **not** `@callable()`: Durable Object RPC between agents does not
need the decorator, and exposing it would let a browser forge sidebar entries.
The update is best-effort; a failed call leaves the preview stale until the next
turn.

## Route the client to a chat

The Worker, not the browser, decides which directory a request belongs to. The
example authenticates the user, resolves their directory by login, and forwards
chat URLs to the matching child with `routeSubAgentRequest()`:

```typescript
import {
  camelCaseToKebabCase,
  getAgentByName,
  routeSubAgentRequest
} from "agents";

const SUB_AGENT_SEGMENT = camelCaseToKebabCase(MyAssistant.name);
const SUB_AGENT_PREFIX = `/chat/sub/${SUB_AGENT_SEGMENT}/`;

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === "/chat" || url.pathname.startsWith("/chat/")) {
      const user = await getGitHubUserFromRequest(request);
      if (!user) return createUnauthorizedResponse(request);

      const directory = await getAgentByName(
        env.AssistantDirectory as DurableObjectNamespace<AssistantDirectory>,
        user.login
      );

      if (url.pathname.startsWith(SUB_AGENT_PREFIX)) {
        const childPath = url.pathname.slice(SUB_AGENT_PREFIX.length);
        return routeSubAgentRequest(request, directory, {
          fromPath: `/sub/${SUB_AGENT_SEGMENT}/${childPath}`
        });
      }

      // `/chat` and `/chat/mcp-callback` belong to the directory itself.
      return directory.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
```

The example intentionally does not fall back to `routeAgentRequest()`. That
would let a client address `/agents/assistant-directory/<login>` or a chat by id
without passing the authenticated `/chat*` gate. `wrangler.jsonc` routes only
`/auth/*`, `/chat`, and `/chat/*` to the Worker with `run_worker_first`.

The directory then gates which chats can be reached. `onBeforeSubAgent` runs
before a child is woken, so an unknown or deleted chat id gets a 404:

```typescript
export class AssistantDirectory extends Think<Env, DirectoryState> {
  override async onBeforeSubAgent(
    _req: Request,
    { className, name }: { className: string; name: string }
  ): Promise<Request | Response | void> {
    if (!this.hasSubAgent(className, name)) {
      return new Response(`${className} "${name}" not found`, { status: 404 });
    }
  }
}
```

### Connect from React

The client opens one connection to the directory for the sidebar and one to the
active chat. `examples/assistant` wraps the directory connection in a local
`useChats()` hook (`src/use-chats.ts`):

```typescript
import { useAgent } from "agents/react";

export function useChats(): UseChats {
  const directory = useAgent<DirectoryState>({
    agent: "AssistantDirectory",
    basePath: "chat"
    // onMcpUpdate and onMessage handlers: see the sections below
  });

  const chats = directory.state?.chats ?? [];

  const createChat = useCallback(
    async (opts?: { title?: string }) =>
      (await directory.call("createChat", opts ? [opts] : [])) as ChatSummary,
    [directory]
  );

  // renameChat, deleteChat, addMcpServer, removeMcpServer follow the same shape
  return { directory, chats, createChat /* ... */ };
}
```

`useChats()` is example code, not a package export. Copy and adapt it; the chat
list shape, permissions, and shared state are application policy.

Each chat pane connects to its chat through the directory using the `sub`
option, then hands that connection to Think's `useAgentChat`:

```tsx
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/think/react";

function Chat({ chatId }: { chatId: string }) {
  const agent = useAgent({
    agent: "AssistantDirectory",
    basePath: "chat",
    sub: [{ agent: "MyAssistant", name: chatId }]
  });
  const { messages, sendMessage, status } = useAgentChat({ agent });
  // ...
}
```

The app renders the active chat with `key={activeChat.id}`, so switching chats
remounts the pane and resets its local state (input draft, branch map, open
panels). The directory's state is the source of truth for which ids exist; the
client never invents one. When the sidebar loads, or when the active chat is
deleted from another tab, the app selects the most recently active chat.

## Share the workspace

The directory owns one `Workspace` backed by its own SQLite, so a file written in
one chat is visible in every other chat for that user:

```typescript
export class AssistantDirectory extends Think<Env, DirectoryState> {
  workspace = new Workspace({
    sql: this.ctx.storage.sql,
    name: () => this.name,
    onChange: (event) =>
      this.broadcast(JSON.stringify({ type: "workspace-change", event }))
  });

  // One-line delegates, called by child chats over Durable Object RPC.
  // Not @callable(): browsers must not write files through the sidebar socket.
  async readFile(path: string): Promise<string | null> {
    return this.workspace.readFile(path);
  }

  async writeFile(
    path: string,
    content: string,
    mimeType?: Parameters<Workspace["writeFile"]>[2]
  ): Promise<void> {
    return this.workspace.writeFile(path, content, mimeType);
  }

  // ...readFileBytes, writeFileBytes, appendFile, exists, readDir, rm, glob,
  // mkdir, stat, lstat, cp, mv, symlink, readlink
}
```

Each chat replaces Think's default workspace with a `SharedWorkspace` proxy that
forwards every call to the directory. Assigning it as a class field means Think
never creates a per-chat `Workspace`:

```typescript
import type { WorkspaceFsLike } from "@cloudflare/shell";

export class MyAssistant extends Think<Env> {
  override workspace: WorkspaceFsLike = new SharedWorkspace(() =>
    this.parentAgent(AssistantDirectory)
  );
}

export class SharedWorkspace implements WorkspaceFsLike {
  #stubPromise?: Promise<DurableObjectStub<AssistantDirectory>>;

  constructor(
    private getParent: () => Promise<DurableObjectStub<AssistantDirectory>>
  ) {}

  private parent() {
    this.#stubPromise ??= this.getParent();
    return this.#stubPromise;
  }

  async readFile(path: string) {
    return (await this.parent()).readFile(path);
  }

  // ...every other WorkspaceFsLike method forwards the same way
}
```

The proxy implements `WorkspaceFsLike` from `@cloudflare/shell`, which is wider
than the `WorkspaceLike` type Think requires. That lets the same object drive
Think's built-in workspace tools, `createWorkspaceTools(this.workspace)`, the
`state.*` API inside `createExecuteTool(this, ...)`, `fetchTools` workspace
spill, and skill script runners.

To keep file browsers live across chats and tabs, `useChats()` listens for the
directory's `workspace-change` broadcasts and exposes a `workspaceRevision`
counter that chat panes use as a `useEffect` dependency:

```typescript
const directory = useAgent<DirectoryState>({
  agent: "AssistantDirectory",
  basePath: "chat",
  onMessage: (message) => {
    if (typeof message.data !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.data);
    } catch {
      return;
    }
    if (isWorkspaceChangeMessage(parsed)) {
      setWorkspaceRevision((n) => n + 1);
    }
  }
});
```

## Share MCP servers

MCP follows the same shape. The directory owns the server registry, OAuth
credentials, live connections, and tool caches. Browsers manage servers through
two `@callable()` methods on the directory; chats read tools through two
methods that are only reachable over Durable Object RPC:

```typescript
export class AssistantDirectory extends Think<Env, DirectoryState> {
  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url, {
      callbackPath: "chat/mcp-callback"
    });
  }

  @callable()
  async removeServer(id: string): Promise<void> {
    await this.removeMcpServer(id);
  }

  // Child-only. Waits for in-progress connections, then snapshots tools.
  async listMcpToolDescriptors(
    timeoutMs = 5_000
  ): Promise<McpToolDescriptor[]> {
    await this.mcp.waitForConnections({ timeout: timeoutMs });
    return this.mcp.listTools() as McpToolDescriptor[];
  }

  // Child-only. Not @callable(), so a browser cannot bypass the chat's
  // beforeToolCall / afterToolCall hooks.
  async callMcpTool(
    serverId: string,
    name: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult> {
    return (await this.mcp.callTool({
      arguments: args,
      name,
      serverId
    })) as CallToolResult;
  }
}
```

The directory also configures the OAuth popup response in `onStart()` with
`this.mcp.configureOAuthCallback({ customHandler })`. The callback URL
`/chat/mcp-callback` reaches the directory through the same authenticated
`/chat*` gate, so one URL serves every server and every chat.

Each chat builds an AI SDK `ToolSet` from the directory's descriptors on every
turn and merges it through `beforeTurn`. Think merges `TurnConfig.tools` on top
of the base tool set:

```typescript
export class MyAssistant extends Think<Env> {
  sharedMcp = new SharedMCPClient(() => this.parentAgent(AssistantDirectory));

  async beforeTurn(ctx: TurnContext): Promise<TurnConfig | void> {
    const mcpTools = await this.sharedMcp.getAITools();
    return { tools: mcpTools };
  }
}
```

`SharedMCPClient.getAITools()` (in `agents/assistant/shared-mcp-client.ts`)
converts each descriptor's JSON Schema with `z.fromJSONSchema`, uses the same
`tool_<serverId>_<name>` key format as `MCPClientManager`, and routes each
tool's `execute` to `parent.callMcpTool(...)`, turning an MCP `isError` result
into a thrown error. The chat's own `this.mcp` stays empty.

On the client, `useChats()` passes an `onMcpUpdate` handler to the directory
connection and exposes the resulting `mcpState`, plus `addMcpServer` and
`removeMcpServer`, so every chat pane and tab shows the same server list.

## What stays per chat

Everything not proxied to the directory lives in the chat's own storage:

- **Messages and branches.** Each chat has its own Session. The example exposes
  regenerated response versions with a `@callable()` wrapper around
  `this.session.getBranches(userMessageId)`.
- **Memory.** `configureContext()` in `MyAssistant` declares `soul`, `memory`,
  and a searchable `knowledge` block. They are stored per chat, so a fact the
  model saves in one chat is not visible in another. Think does not ship a
  cross-Durable-Object context provider; to share memory, store it on the
  directory and expose it through your own RPC.
- **Extensions.** `ExtensionManager` persists extensions in the chat's Durable
  Object storage, not in the workspace, so a tool the model authors in chat A is
  not available in chat B.
- **Configuration.** `configure()` / `getConfig()` (model tier and persona in
  the example) are per chat.
- **Client tools and approvals** run over the chat's own WebSocket.

## Run cross-chat scheduled work

Work that spans chats belongs to the directory. The example declares a daily
summary as a Think scheduled task on the directory; its handler picks the most
recently active chat and RPCs into it:

```typescript
export class AssistantDirectory extends Think<Env, DirectoryState> {
  override getDefaultTimezone(): string {
    return "UTC";
  }

  override getScheduledTasks(): ThinkScheduledTasks {
    return {
      dailySummary: {
        schedule: "every day at 09:00",
        handler: async () => {
          const [row] = this.sql<{ id: string }>`
            SELECT id FROM chat_meta ORDER BY updated_at DESC LIMIT 1
          `;
          if (!row) return;
          const target = await this.subAgent(MyAssistant, row.id);
          await target.postDailySummaryPrompt();
        }
      }
    };
  }
}
```

`postDailySummaryPrompt()` on the chat calls `saveMessages()` with a user
message, which runs a normal durable turn in that chat. Like `recordChatTurn()`,
it is not `@callable()`.

See [Scheduled Tasks](./index.md#scheduled-tasks) for the schedule syntax.

## Known limits

- **Facet topology.** Because the example's chats are facets of the directory,
  they are colocated with it on one machine, share its physical alarm, and
  depend on the root for their native WebSockets. The
  [dynamic agents guide](https://github.com/cloudflare/agents/blob/main/docs/agents/sub-agents.md#when-to-use-dynamic-agents)
  lists these tradeoffs and recommends top-level chat Durable Objects for many
  long-lived chats per user.
  [`rfc-user-chat-durable-objects.md`](https://github.com/cloudflare/agents/blob/main/design/rfc-user-chat-durable-objects.md)
  records the planned migration of `examples/assistant`: chats become top-level
  objects and the proxies look up the directory with `getAgentByName()` instead
  of `parentAgent()`. The workspace and MCP boundaries do not change.
- **The directory is the fan-in point.** Every shared workspace call and every
  MCP tool call from every chat is one RPC into the directory's single-threaded
  isolate. Writes to the same path serialize there, and concurrent MCP calls
  interleave on its event loop. The directory keeps one live connection per
  registered MCP server. The SDK does not yet publish measured limits for this
  fan-out.
- **Shared means shared.** Every chat can read and write every file the user
  owns and call every connected MCP tool. Extensions declared with
  `workspace: "read-write"` inherit the same reach. For less-trusted surfaces,
  gate access in the directory's RPC methods, filter tools in the MCP proxy, or
  remove the `workspace` override so each chat keeps a private workspace.
- **No server-side cross-chat events.** Workspace changes are broadcast to
  browser tabs connected to the directory, not delivered to other chat agents.
  Add a directory-to-chat RPC if a tool must react to another chat's writes.
- **Sidebar metadata is best-effort.** `recordChatTurn()` is an unconditional
  upsert and can run after the chat was deleted. The resulting `chat_meta` row
  is ignored because the registry decides which chats exist, but it is not
  cleaned up. The example does not coordinate `deleteChat()` with a turn that is
  still running.
- **No cross-chat search.** Each chat's Session search covers only that chat.
  The example has no directory-level search index.
- **No packaged helpers.** There is no `Chats` base class and `useChats()` is not
  exported from any package. The pattern is documented through
  `examples/assistant` until the shape settles.

## Related

- [Sub-agents and Programmatic Turns](./sub-agents.md) — `chat()`, `saveMessages()`, and parent-to-child turns
- [Tools](./tools.md) — workspace tools, code execution, and MCP tools
- [Lifecycle Hooks](./lifecycle-hooks.md) — `beforeTurn` and `onChatResponse`
- [Dynamic agents](https://github.com/cloudflare/agents/blob/main/docs/agents/sub-agents.md) — `onBeforeSubAgent`, `parentAgent()`, `useAgent({ sub })`, and routing
- [Routing to independent Agents](https://github.com/cloudflare/agents/blob/main/docs/agents/routing.md#routing-to-independent-agents) — `RoutedAgents` for top-level chat Durable Objects
- [`examples/assistant`](https://github.com/cloudflare/agents/tree/main/examples/assistant) — the full reference app
