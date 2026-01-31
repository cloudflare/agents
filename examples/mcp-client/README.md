# MCP Client Demo Using Agents

A minimal example showing an `Agent` as an MCP client with support for both SSE and HTTP Streamable transports.

## Transport Options

The MCP client supports two transport types:

- **HTTP Streamable** (recommended): Uses HTTP POST + SSE for better performance and reliability
- **SSE (Server-Sent Events)**

## Instructions

First, start an MCP server. A simple example can be found in `examples/mcp`, which already has a valid binding setup.

Then, follow the steps below to setup the client:

1. This example uses a pre-built version of the agents package. Run `npm run build` in the root of this repo to build it.
2. Copy the `.dev.vars.example` file in this directory to a new file called `.dev.vars`.
3. Run `npm install` from this directory.
4. Run `npm start` from this directory.

Tap "O + enter" to open the front end. It should list out all the tools, prompts, and resources available for each server added.

## Usage

The recommended way to add MCP servers is via `Agent.addMcpServer()`:

```typescript
export class MyAgent extends Agent<Env, never> {
  async addServer(name: string, url: string) {
    // Simple usage - callback host derived from request
    await this.addMcpServer(name, url);
  }

  async addServerWithOptions(name: string, url: string) {
    // With options
    await this.addMcpServer(name, url, {
      callbackHost: "https://my-worker.workers.dev",
      transport: { type: "sse" }
    });
  }
}
```

The MCP client handles OAuth authentication automatically using the built-in `DurableObjectOAuthClientProvider`.
