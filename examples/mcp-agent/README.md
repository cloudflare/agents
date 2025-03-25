# MCPAgent Example

A minimal example showing an `McpAgent` running in Wrangler, which supports both regular HTTP requests and MCP HTTP requests (under `/mcp`).

It uses a custom implementation of a `HTTPTransport`, which is in preparation for the serverless-compatible MCP servers which that allow requests to be "promoted" to SSE (or even Websockets; great with Cloudflare and agents 😉) if they are needed to.

## Instructions

To make your Agent MCP compatible, all you need to do is implement the methods of:

- `createServerParams` - defining the MCP server specification and capabilities
- `configureServer` - set up the handlers for the capabilities
- (OPTIONAL) `createTransport` - the transport to use (uses `HTTPTransport` by default)
- (OPTIONAL) `onRequest` - if you want to update the standard `onRequest` behavior.

**Note:** The `MCPAgent` class overrides the standard `Agent`'s `fetch` method to send all requests under `/mcp` to the MCP server.

### Running the example

1. Run the dev server

```sh
npm run dev
```

2. Call the server using either a regular `GET` request:

```sh
curl -X GET "http://localhost:8787"
```

Result:

```json
{ "data": 917 }
```

Or a `POST` JSON RPC message:

```sh
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "random",
      "arguments": {}
    }
  }' \
  "http://localhost:8787/mcp"
```

Result:

```json
[
  {
    "result": { "content": [{ "type": "text", "text": "520" }] },
    "jsonrpc": "2.0",
    "id": 1
  }
]
```

### Simple example implementation

Below is a simple agent with an `example` tool returning "Hello world".
See [`src/server.ts`]("./src/server.ts") for a (slightly) more in-depth example.

```ts
export class RandomMCPAgent extends MCPAgent<Env> {
  async onRequest(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return new Response("Unsupported method", { status: 400 });
    }
    return new Response(JSON.stringify({ data: await this.random() }));
  }

  createServerParams(): [Implementation, ServerOptions] {
    return [
      { name: "Demo", version: "1.0.0" },
      {
        capabilities: {
          tools: { listChanged: true, random: true },
        },
      },
    ];
  }

  configureServer(server: Server): void {
    server.setRequestHandler(ListToolsRequestSchema, () => {
      return {
        tools: [{ name: "example", description: "An example tool" }],
      };
    });
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      if (params.name !== "example") throw new Error("Unknown tool");

      return {
        content: [{ type: "text", text: "Hello, world!" }],
      };
    });
  }
}

export default class Worker extends WorkerEntrypoint<Env> {
  /**
   * @ignore
   **/
  async fetch(request: Request): Promise<Response> {
    const agent = await getAgentByName(this.env.RANDOM, "random");
    return await agent.fetch(request);
  }
}
```
