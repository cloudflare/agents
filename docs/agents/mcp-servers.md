# Creating MCP Servers

This guide covers the different ways to create MCP servers with the Agents SDK and helps you choose the right approach.

## Choosing an Approach

| Approach                                       | Stateful? | Requires Durable Objects? | Best for                                          |
| ---------------------------------------------- | --------- | ------------------------- | ------------------------------------------------- |
| `createMcpHandler()`                           | No        | No                        | New servers and the latest MCP protocol           |
| `McpAgent` (deprecated legacy path)            | Yes       | Yes                       | Existing stateful SDK v1 deployments              |
| Raw `WebStandardStreamableHTTPServerTransport` | No        | No                        | Low-level control without the Agents HTTP wrapper |

- **`createMcpHandler()`** is the current server-development path. It serves MCP `2026-07-28` and supports stateless 2025 clients by default.
- **`McpAgent`** is a retained, feature-frozen SDK v1 path for existing stateful deployments. New servers should use `createMcpHandler()`.
- **Raw transport** gives you low-level control if the standard handler lifecycle is not suitable.

## Stateless MCP Server with `createMcpHandler()`

The simplest way to create an MCP server. Install the server package directly, then import its constructor alongside the Agents handler:

```sh
pnpm add agents @modelcontextprotocol/sdk@1.29.0 @modelcontextprotocol/server@2.0.0-beta.4 zod
```

```typescript
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";

function createServer() {
  const server = new McpServer({
    name: "Hello MCP Server",
    version: "1.0.0"
  });

  server.registerTool(
    "hello",
    {
      description: "Returns a greeting message",
      inputSchema: { name: z.string().optional() }
    },
    async ({ name }) => ({
      content: [{ text: `Hello, ${name ?? "World"}!`, type: "text" }]
    })
  );

  return server;
}

export default createMcpHandler(createServer);
```

`createMcpHandler` requires a factory so concurrent Worker requests receive isolated server instances. A function input is always treated as an SDK v2 factory.

### `createMcpHandler` options

```typescript
createMcpHandler(() => createServer(), {
  route: "/mcp",             // exact path to handle (default: "/mcp")
  corsOptions: { ... },       // Agents CORS configuration; false disables it
  authContext: { props: {} }, // optional application props override
  legacy: "stateless",       // upstream default; use "reject" for modern-only
  responseMode: "auto"       // upstream SDK response shaping
});
```

All upstream SDK v2 handler options pass through. Use `createLegacyMcpHandler` for WorkerTransport, storage, session, and event-store options.

### 2025 compatibility and elicitation

The default `legacy: "stateless"` lane supports ordinary 2025 tools, resources, and prompts. It has no session return path for push-style server-to-client requests; attempts to sample, elicit, or list roots fail immediately with guidance to use a sessionful transport.

Applications that must keep push-style 2025 elicitation while adding modern multi-round-trip elicitation should route before `createMcpHandler`: send modern requests to a strict stateless v2 handler and legacy requests to their existing session-addressed Agent/transport. See [`examples/mcp-elicitation`](../../examples/mcp-elicitation/) for both paths on one endpoint.

For an explicit 2025-era handler, use the retained legacy API:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createLegacyMcpHandler } from "agents/mcp";

const server = new McpServer({ name: "legacy", version: "1.0.0" });
export default createLegacyMcpHandler(server);
```

Passing an SDK v1 server directly to `createMcpHandler` still forwards to this API for compatibility, but that overload is deprecated, emits a migration warning, and is removed in the next major release. `createLegacyMcpHandler` and `WorkerTransport` themselves are not deprecated.

### Accessing Authenticated User Context

When your MCP server is wrapped with `OAuthProvider` from `@cloudflare/workers-oauth-provider`, provider-issued tokens are available through standard SDK v2 `AuthInfo`. The existing `getMcpAuthContext()` application-props helper remains supported:

```typescript
import { createMcpHandler, getMcpAuthContext } from "agents/mcp";

server.registerTool(
  "whoami",
  { description: "Returns the authenticated user" },
  async (context) => {
    const auth = getMcpAuthContext();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            clientId: context.http?.authInfo?.clientId,
            scopes: context.http?.authInfo?.scopes,
            props: auth?.props
          })
        }
      ]
    };
  }
);
```

Do not log or return `context.http.authInfo.token`. External-token resolvers continue providing `getMcpAuthContext().props` but do not synthesize incomplete standard metadata.

## Stateful MCP Server with `McpAgent` (legacy)

`McpAgent` gives each client session its own Durable Object with persistent state. It remains available for existing SDK v1 deployments but is deprecated and feature-frozen; new servers should use the stateless handler or explicitly compose a separate legacy route where a session is required.

### Writing TinyMCP

Prototyping is very easy! If you want to quickly deploy an MCP, it only takes ~20 lines of code:

```typescript
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Our MCP server!
export class TinyMcp extends McpAgent {
  server = new McpServer({ name: "", version: "v1.0.0" });

  async init() {
    this.server.registerTool(
      "square",
      {
        description: "Squares a number",
        inputSchema: { number: z.number() }
      },
      async ({ number }) => ({
        content: [{ type: "text", text: String(number ** 2) }]
      })
    );
  }
}

// This is literally all there is to our Worker
export default TinyMcp.serve("/");
```

Your `wrangler.jsonc` would look something like:

```jsonc
{
  "name": "tinymcp",
  "main": "src/index.ts",
  "compatibility_date": "2026-01-28",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [
      {
        "name": "MCP_OBJECT",
        "class_name": "TinyMcp"
      }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["TinyMcp"]
    }
  ]
}
```

### What is going on here?

`McpAgent` requires us to define 2 bits, `server` and `init()`.

`init()` is the initialization logic that runs every time our MCP server is started (each client session goes to a different Agent instance).  
In there you'll normally setup all your tools/resources and anything else you might need. In this case, we're only setting the tool `square`.

That was just the `McpAgent`, but we still need a Worker to route requests to our MCP server. `McpAgent` exports a static method that deals with that for you. That's what `TinyMcp.serve(...)` is for.  
It returns an object with a `fetch` handler that can act as our Worker entrypoint and deal with the Streamable HTTP transport for us, so we can deploy our MCP directly!

### Putting it to the test

It's a very simple MCP indeed, but you can get a feel of how fast you can get a server up and running. You can deploy this worker and test your MCP with any client. I'll try with https://playground.ai.cloudflare.com:
![model calls the square tool after connecting to our mcp](https://github.com/user-attachments/assets/1e979a82-ed3e-49e9-b9d5-a3fc9b0363a7)

## Password-protected StorageMcp with OAuth!

To get a feel of what a more realistic MCP might look like, let's deploy an MCP that lets anyone that knows our secret password access a shared R2 bucket. (This is an example of a custom authorization flow, please do **not** use this in production)

```typescript
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  OAuthProvider,
  type OAuthHelpers
} from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { env } from "cloudflare:workers";

export class StorageMcp extends McpAgent {
  server = new McpServer({ name: "", version: "v1.0.0" });

  async init() {
    // Helper to return text responses from our tools
    const textRes = (text: string) => ({
      content: [{ type: "text" as const, text }]
    });

    this.server.registerTool(
      "writeFile",
      {
        description: "Store text as a file with the given path",
        inputSchema: {
          path: z.string().describe("Absolute path of the file"),
          content: z.string().describe("The content to store")
        }
      },
      async ({ path, content }) => {
        try {
          await env.BUCKET.put(path, content);
          return textRes(`Successfully stored contents to ${path}`);
        } catch (e: unknown) {
          return textRes(`Couldn't save to file. Found error ${e}`);
        }
      }
    );

    this.server.registerTool(
      "readFile",
      {
        description: "Read the contents of a file",
        inputSchema: {
          path: z.string().describe("Absolute path of the file to read")
        }
      },
      async ({ path }) => {
        const obj = await env.BUCKET.get(path);
        if (!obj || !obj.body)
          return textRes(`Error reading file at ${path}: not found`);
        try {
          return textRes(await obj.text());
        } catch (e: unknown) {
          return textRes(`Error reading file at ${path}: ${e}`);
        }
      }
    );

    this.server.registerTool(
      "whoami",
      {
        description: "Check who the user is"
      },
      async () => {
        return textRes(`${this.props?.userId}`);
      }
    );
  }
}

// HTML form page for users to write our password
function passwordPage(opts: { query: string; error?: string }) {
  const err = opts.error
    ? `<p class="text-red-600 mb-2">${opts.error}</p>`
    : "";
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ENTER THE MAGIC WORD</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="font-sans grid place-items-center min-h-screen bg-gray-100">
  <form method="POST" action="/authorize?${opts.query}" 
        class="bg-white p-6 rounded-lg shadow-md w-full max-w-xs">
    <h1 class="text-lg font-semibold mb-3">ENTER THE MAGIC WORD</h1>
    ${err}
    <label class="block text-sm mb-1">Password</label>
    <input name="password" type="password" required autocomplete="current-password"
           class="w-full border rounded px-3 py-2 mb-3" />
    <button type="submit"
            class="w-full py-2 bg-black text-white rounded font-medium hover:bg-gray-800">
      Continue
    </button>
  </form>
</body>
</html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

// This is the default handler of our worker BEFORE requests are authenticated.
interface StorageEnv {
  OAUTH_PROVIDER: OAuthHelpers;
  SHARED_PASSWORD: string;
}

const defaultHandler = {
  async fetch(request: Request, env: StorageEnv) {
    const provider = env.OAUTH_PROVIDER;
    const url = new URL(request.url);

    // Only handle our auth UI/flow here
    if (url.pathname !== "/authorize") {
      return new Response("NOT FOUND", { status: 404 });
    }

    // Parse the OAuth request
    const oauthReq = await provider.parseAuthRequest(request);

    // We render the password page for GET requests
    if (request.method === "GET") {
      return passwordPage({ query: url.searchParams.toString() });
    }

    // We validate the password in POST requests
    if (request.method === "POST") {
      const form = await request.formData();
      const password = String(form.get("password") || "");

      const SHARED_PASSWORD = env.SHARED_PASSWORD; // Store this as a secret
      if (!SHARED_PASSWORD) {
        return new Response("Server misconfigured: missing SHARED_PASSWORD", {
          status: 500
        });
      }
      if (password !== SHARED_PASSWORD) {
        return passwordPage({
          query: url.searchParams.toString(),
          error: "Wrong password."
        });
      }

      // We give everyone the same userId
      const userId = "friend";

      const { redirectTo } = await provider.completeAuthorization({
        request: oauthReq,
        userId,
        scope: [], // We don't care about scopes

        // We could add anything we wanted here so we could access it
        // within the MCP with `this.props`
        props: { userId },
        metadata: undefined
      });

      return Response.redirect(redirectTo, 302);
    }

    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET, POST" }
    });
  }
};

// OAuthProvider creates our worker handler
export default new OAuthProvider({
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  apiHandlers: { "/mcp": StorageMcp.serve("/mcp") },
  defaultHandler
});
```

You would also add these to your `wrangler.jsonc`:

```jsonc
{
  // rest of your config...
  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "your-bucket-name" }],
  "kv_namespaces": [
    {
      "binding": "OAUTH_KV", // required by OAuthProvider
      "id": "your-kv-id"
    }
  ]
}
```

### What's going on?

In ~160 lines we were able to write our custom OAuth authorization flow so anyone that knows our secret password can use the MCP server.

Just like before, in `init()` we set a few tools to access files in our R2 bucket. We also have the `whoami` tool to show users what `userId` we authenticated them with. It's just an example of how to access `props` from within the `McpAgent`.

Most of the code here is either the HTML page to type in the password or the OAuth `/authorize` logic.
The important part is to notice how in the `OAuthProvider` we expose the `StorageMcp` through the `apiHandlers` key and use the same `serve` method we were using before.

### Let's see how this looks like

Once again, using https://playground.ai.cloudflare.com:
![password page](https://github.com/user-attachments/assets/8e469110-fffa-45d2-84c1-ae16a651ae41)
The auth flow prompts us for the password.

![model calls all 3 tools after authorization](https://github.com/user-attachments/assets/07e22fef-93de-47c2-af7e-9c361e460186)
Once we've authenticated ourselves we can use all the tools!

## Data Jurisdiction for Compliance

`McpAgent` supports specifying a data jurisdiction for your MCP server, which is particularly useful for satisfying GDPR and other data residency regulations. By setting the `jurisdiction` option, you can ensure that your Durable Object instances (and their data) are created in a specific geographic region.

### Using the EU Jurisdiction for GDPR

To comply with GDPR requirements, you can specify the `"eu"` jurisdiction to ensure that all data processed by your MCP server remains within the European Union:

```typescript
export default TinyMcp.serve("/", {
  jurisdiction: "eu"
});
```

Or with the OAuth-protected example:

```typescript
export default new OAuthProvider({
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  apiHandlers: {
    "/mcp": StorageMcp.serve("/mcp", { jurisdiction: "eu" })
  },
  defaultHandler
});
```

When you specify `jurisdiction: "eu"`, Cloudflare will create the Durable Object instances in EU data centers, ensuring that:

- All MCP session data stays within the EU
- User data processed by your tools remains in the EU
- State stored in the Durable Object's storage API stays in the EU

This helps you comply with GDPR's data localization requirements without any additional configuration.

### Available Jurisdictions

The `jurisdiction` option accepts any value supported by [Cloudflare's Durable Objects jurisdiction API](https://developers.cloudflare.com/durable-objects/reference/data-location/), including:

- `"eu"` - European Union
- `"fedramp"` - FedRAMP compliant locations

## Elicitation (Human-in-the-Loop)

MCP servers can request additional input from the user during a tool call using elicitation. This is useful for confirmation dialogs, requesting amounts, or any interactive tool flow.

Elicitation is supported via `McpAgent` (which manages the request/response lifecycle through Durable Object storage) or via `WorkerTransport` (for stateful non-McpAgent setups).

```typescript
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export class MyMCP extends McpAgent<Env, { counter: number }> {
  server = new McpServer({ name: "Elicitation Demo", version: "1.0.0" });

  initialState = { counter: 0 };

  async init() {
    this.server.registerTool(
      "increase-counter",
      {
        description: "Increase the counter",
        inputSchema: {
          confirm: z.boolean().describe("Do you want to increase the counter?")
        }
      },
      async ({ confirm }, extra) => {
        if (!confirm) {
          return { content: [{ type: "text", text: "Cancelled." }] };
        }

        const result = await this.server.server.elicitInput(
          {
            message: "By how much?",
            requestedSchema: {
              type: "object",
              properties: {
                amount: { type: "number", title: "Amount" }
              },
              required: ["amount"]
            }
          },
          { relatedRequestId: extra.requestId }
        );

        if (result.action !== "accept" || !result.content?.amount) {
          return { content: [{ type: "text", text: "Cancelled." }] };
        }

        const amount = Number(result.content.amount);
        this.setState({ counter: this.state.counter + amount });

        return {
          content: [
            {
              type: "text",
              text: `Counter increased by ${amount}, now ${this.state.counter}`
            }
          ]
        };
      }
    );
  }
}

export default MyMCP.serve("/mcp");
```

See the [`examples/mcp-elicitation`](https://github.com/cloudflare/agents/tree/main/examples/mcp-elicitation) example for a full working demo.

## WorkerTransport

`WorkerTransport` is the Agents Workers transport for 2025-era MCP. Use it directly with `createLegacyMcpHandler` for persistent sessions, storage, event replay, and other explicit legacy configurations. The SDK v2 handler also uses a sessionless `WorkerTransport` internally for its stateless 2025 fallback; this does not emit a deprecation warning.

```typescript
import { WorkerTransport, type TransportState } from "agents/mcp";

const transport = new WorkerTransport({
  sessionIdGenerator: () => crypto.randomUUID(),
  enableJsonResponse: false,
  storage: {
    get: () => kv.get<TransportState>("mcp_state"),
    set: (state: TransportState) => kv.put<TransportState>("mcp_state", state)
  }
});
```

Key options:

| Option               | Description                                                                    |
| -------------------- | ------------------------------------------------------------------------------ |
| `sessionIdGenerator` | Function that returns a session ID for new sessions                            |
| `enableJsonResponse` | Return JSON instead of SSE streams (default: `false`)                          |
| `storage`            | Optional `{ get, set }` adapter for persisting transport state across requests |
| `corsOptions`        | CORS configuration                                                             |

### Read more

For more complex examples including authentication with third-party providers, see the [examples directory](https://github.com/cloudflare/agents/tree/main/examples).
