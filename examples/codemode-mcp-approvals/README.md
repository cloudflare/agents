# Durable Code Mode MCP approvals

A two-tool MCP server that uses Code Mode's durable abort-and-replay runtime to enforce approval on the operations hidden inside generated code.

The server is a regular [`Agent`](../../packages/agents) using a persistent `WorkerTransport` and `createMcpHandler()`.

## Run it

```bash
pnpm install
pnpm run dev
```

Connect an MCP client that supports form-mode elicitation to:

```text
http://localhost:8787/mcp
```

## MCP tools

- **`search`** searches connector methods and describes their input types. Results indicate whether a method requires approval.
- **`execute`** runs an async JavaScript arrow function with the durable Code Mode runtime.

The demo connector models issue and merge-request operations:

| Operation                        | Policy                      |
| -------------------------------- | --------------------------- |
| List issues or merge requests    | Allow                       |
| Add a comment                    | Allow                       |
| Create an issue or merge request | Ask through MCP elicitation |

Try an allowed operation:

```js
async () =>
  work.comment_on_issue({
    issueId: "ISSUE-1",
    body: "Looks good"
  });
```

Try a protected operation:

```js
async () => work.create_issue({ title: "Ship the example" });
```

## How approval works

When generated code reaches `work.create_issue()`:

1. The connector's host-owned definition has `requiresApproval: true`.
2. The durable runtime records the exact method and arguments as pending, aborts the sandbox pass, and disposes that Dynamic Worker.
3. The MCP tool handler sends `elicitation/create` on the original `tools/call` response stream.
4. On acceptance, `runtime.approve()` starts a fresh sandbox pass. Earlier calls replay from the durable log, the approved action executes once, and the script continues.
5. On decline or cancellation, `runtime.reject()` ends the execution without running the protected action.

The outer MCP surface stays at two tools, but permission checks happen on each nested connector operation. The model cannot approve itself because there is no approval MCP tool.

```ts
export class CodemodeMcp extends Agent<Env> {
  transport = new WorkerTransport({
    sessionIdGenerator: () => this.name,
    storage: {
      get: () => this.ctx.storage.kv.get("mcp_transport_state"),
      set: (state) => this.ctx.storage.kv.put("mcp_transport_state", state)
    }
  });

  async onMcpRequest(request: Request) {
    return createMcpHandler(this.server, {
      transport: this.transport
    })(request, this.env, {} as ExecutionContext);
  }
}
```

`CodemodeRuntime` is exported from the Worker entry module so `createCodemodeRuntime()` can create its durable facet.

## Production notes

- Treat connectors as the enforcement boundary. Do not expose an unguarded generic `request()` escape hatch that can bypass operation-level policy.
- Bind the Agent to an authenticated user identity in production. This demo uses the MCP session ID only to stay focused on approvals.
- Nested elicitation is request-scoped. The Code Mode execution is durable, but the original MCP call still needs a live client response. Use a detached continuation flow for approvals that may take hours.
- Rejecting a later action does not roll back allowed actions that already ran earlier in the script. Use `runtime.rollback()` and connector `revert` implementations when compensation is required.

## Related examples

- [`codemode-mcp-openapi`](../codemode-mcp-openapi/) — stateless OpenAPI `search` + `execute`
- [`codemode-connectors`](../codemode-connectors/) — durable Code Mode approvals in a chat UI
- [`mcp-elicitation`](../mcp-elicitation/) — form and URL elicitation with a plain Agent
