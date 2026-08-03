import { Agent, routeAgentRequest } from "agents";
import type { Executor } from "@cloudflare/codemode";
import { codeMcpServer } from "@cloudflare/codemode/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type Env = {
  ReproAgent: DurableObjectNamespace<ReproAgent>;
};

async function atStage<T>(label: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${message}`);
  }
}

function textFromToolResult(
  result: Awaited<ReturnType<Client["callTool"]>>
): string {
  const item = result.content.find(
    (content): content is { type: "text"; text: string } =>
      content.type === "text" && "text" in content
  );
  if (!item) throw new Error("The code tool returned no text content");
  return item.text;
}

async function runRepro(detailLength = 70_000) {
  const upstream = new McpServer({
    name: "fixture-upstream",
    version: "1.0.0"
  });
  upstream.registerTool(
    "noop",
    { description: "Fixture tool", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: "ok" }] })
  );

  const executor: Executor = {
    async execute() {
      return {
        result: {
          schema: "fixture_v1",
          rows: [{ detail: "x".repeat(detailLength) }]
        }
      };
    }
  };

  const wrapped = await atStage("create wrapper", () =>
    codeMcpServer({ server: upstream, executor })
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await atStage("connect wrapped server", () => wrapped.connect(serverTransport));

  const client = new Client({ name: "repro-client", version: "1.0.0" });
  await atStage("connect outer client", () => client.connect(clientTransport));
  try {
    const result = await atStage("call outer code tool", () =>
      client.callTool({
        name: "code",
        arguments: { code: "async () => ({ ignored: true })" }
      })
    );
    const text = textFromToolResult(result);
    let jsonValid = true;
    try {
      JSON.parse(text);
    } catch {
      jsonValid = false;
    }
    return {
      detailLength,
      returnedTextLength: text.length,
      jsonValid,
      hasTruncationMarker: text.includes("--- TRUNCATED ---"),
      tail: text.slice(-220)
    };
  } finally {
    await client.close();
  }
}

export class ReproAgent extends Agent<Env> {
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || !url.pathname.endsWith("/trigger")) {
      return new Response("Not found", { status: 404 });
    }
    try {
      return Response.json(await runRepro());
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
