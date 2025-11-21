# Creating your own MCP Server with an McpAgent

This guide aims to help you get familiar with `McpAgent` and guide you through writing your own MCP servers.

## Writing TinyMCP

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
      }
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
  "compatibility_date": "2025-08-26",
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
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
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
const defaultHandler = {
  async fetch(request: Request, env: any) {
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

### Read more

To find out how to use your favorite providers for your authorization flow and more complex examples, have a look at the demos [here](https://github.com/cloudflare/ai/tree/main/demos).
