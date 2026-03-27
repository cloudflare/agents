import { Agent, routeAgentRequest, getAgentByName } from "agents";
import {
  streamText,
  convertToModelMessages,
  stepCountIs,
  tool,
  type UIMessage
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import { createCodeTool, resolveProvider } from "../src/ai";
import { DynamicWorkerExecutor } from "../src/index";
import { generateTypes } from "../src/ai";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { codeMcpServer } from "../src/mcp";

type Env = {
  AI: Ai;
  LOADER: WorkerLoader;
  CodemodeAgent: DurableObjectNamespace<CodemodeAgent>;
};

// ── Tool definitions ──────────────────────────────────────────────

const pmTools = {
  createProject: tool({
    description: "Create a new project",
    inputSchema: z.object({
      name: z.string().describe("Project name"),
      description: z.string().optional().describe("Project description")
    }),
    execute: async ({ name, description }) => ({
      id: crypto.randomUUID(),
      name,
      description: description ?? ""
    })
  }),

  listProjects: tool({
    description: "List all projects",
    inputSchema: z.object({}),
    execute: async () => [
      { id: "proj-1", name: "Alpha", description: "First project" },
      { id: "proj-2", name: "Beta", description: "Second project" }
    ]
  }),

  addNumbers: tool({
    description: "Add two numbers together",
    inputSchema: z.object({
      a: z.number().describe("First number"),
      b: z.number().describe("Second number")
    }),
    execute: async ({ a, b }) => ({ result: a + b })
  }),

  getWeather: tool({
    description: "Get the current weather for a city",
    inputSchema: z.object({
      city: z.string().describe("The city name")
    }),
    execute: async ({ city }) => ({
      city,
      temperature: 22,
      condition: "Sunny"
    })
  })
};

const mathTools = {
  multiply: tool({
    description: "Multiply two numbers",
    inputSchema: z.object({
      a: z.number().describe("First number"),
      b: z.number().describe("Second number")
    }),
    execute: async ({ a, b }) => ({ result: a * b })
  }),

  divide: tool({
    description: "Divide two numbers",
    inputSchema: z.object({
      a: z.number().describe("Numerator"),
      b: z.number().describe("Denominator")
    }),
    execute: async ({ a, b }) => {
      if (b === 0) throw new Error("Division by zero");
      return { result: a / b };
    }
  })
};

const validatedTools = {
  strictAdd: tool({
    description: "Add two numbers (strict validation)",
    inputSchema: z.object({
      a: z.number(),
      b: z.number()
    }),
    execute: async ({ a, b }) => ({ result: a + b })
  })
};

// ── Agent ─────────────────────────────────────────────────────────

export class CodemodeAgent extends Agent<Env> {
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/chat") && request.method === "POST") {
      return this.handleChat(request);
    }

    if (url.pathname.endsWith("/generate-types")) {
      return Response.json({ types: generateTypes(pmTools) });
    }

    return new Response("Not found", { status: 404 });
  }

  async handleChat(request: Request): Promise<Response> {
    const body = (await request.json()) as { messages: UIMessage[] };

    const workersai = createWorkersAI({ binding: this.env.AI });
    const model = workersai("@cf/moonshotai/kimi-k2.5", {
      sessionAffinity: this.sessionAffinity
    });

    const executor = new DynamicWorkerExecutor({
      loader: this.env.LOADER
    });

    const codemode = createCodeTool({
      tools: pmTools,
      executor
    });

    const result = streamText({
      model,
      system: `You are a helpful assistant with access to a codemode tool.
When asked to perform operations, use the codemode tool to write JavaScript code that calls the available functions on the \`codemode\` object.
Keep responses very short (1-2 sentences max).
When asked to add numbers, use the addNumbers tool via codemode.
When asked about weather, use the getWeather tool via codemode.
When asked about projects, use createProject or listProjects via codemode.`,
      messages: await convertToModelMessages(body.messages),
      tools: { codemode },
      stopWhen: stepCountIs(5)
    });

    return result.toTextStreamResponse();
  }
}

// ── Direct executor endpoint ──────────────────────────────────────

type ExecuteBody = {
  code: string;
  preset?: string;
};

async function handleExecute(body: ExecuteBody, env: Env): Promise<Response> {
  const { code, preset = "default" } = body;

  if (preset === "timeout") {
    const executor = new DynamicWorkerExecutor({
      loader: env.LOADER,
      timeout: 100
    });
    const result = await executor.execute(code, [
      resolveProvider({ tools: pmTools })
    ]);
    return Response.json(result);
  }

  if (preset === "withModules") {
    const executor = new DynamicWorkerExecutor({
      loader: env.LOADER,
      modules: {
        "helpers.js":
          'export function greet(name) { return "hello " + name; }\nexport function double(n) { return n * 2; }'
      }
    });
    const result = await executor.execute(code, [
      resolveProvider({ tools: pmTools })
    ]);
    return Response.json(result);
  }

  const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

  if (preset === "multi") {
    const result = await executor.execute(code, [
      resolveProvider({ tools: pmTools }),
      resolveProvider({ name: "math", tools: mathTools })
    ]);
    return Response.json(result);
  }

  if (preset === "positional") {
    const concatFn = async (...args: unknown[]) => {
      return (args as string[]).join(" ");
    };
    const result = await executor.execute(code, [
      {
        name: "state",
        fns: { concat: concatFn },
        positionalArgs: true
      }
    ]);
    return Response.json(result);
  }

  if (preset === "validated") {
    const result = await executor.execute(code, [
      resolveProvider({ tools: validatedTools })
    ]);
    return Response.json(result);
  }

  const result = await executor.execute(code, [
    resolveProvider({ tools: pmTools })
  ]);
  return Response.json(result);
}

// ── MCP executor endpoint ─────────────────────────────────────────

async function handleMcpExecute(
  body: { code: string },
  env: Env
): Promise<Response> {
  const upstream = new McpServer({
    name: "test-tools",
    version: "1.0.0"
  });

  upstream.registerTool(
    "add",
    {
      description: "Add two numbers",
      inputSchema: {
        a: z.number().describe("First number"),
        b: z.number().describe("Second number")
      }
    },
    async ({ a, b }) => ({
      content: [{ type: "text" as const, text: String(a + b) }]
    })
  );

  upstream.registerTool(
    "greet",
    {
      description: "Generate a greeting",
      inputSchema: {
        name: z.string().describe("Name to greet")
      }
    },
    async ({ name }) => ({
      content: [{ type: "text" as const, text: `Hello, ${name}!` }]
    })
  );

  upstream.registerTool(
    "fail_always",
    {
      description: "Always fails",
      inputSchema: {}
    },
    async () => ({
      content: [{ type: "text" as const, text: "something went wrong" }],
      isError: true
    })
  );

  const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
  const wrapped = await codeMcpServer({ server: upstream, executor });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await wrapped.connect(serverTransport);
  const client = new Client({ name: "e2e-client", version: "1.0.0" });
  await client.connect(clientTransport);

  const result = await client.callTool({
    name: "code",
    arguments: { code: body.code }
  });

  await client.close();

  const text = (result.content as Array<{ type: string; text: string }>)[0]
    .text;
  return Response.json({
    text,
    isError: result.isError ?? false
  });
}

// ── LLM multi-provider endpoint ───────────────────────────────────

async function handleRunMulti(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { messages: UIMessage[] };

  const workersai = createWorkersAI({ binding: env.AI });
  const model = workersai("@cf/moonshotai/kimi-k2.5");

  const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

  const codemode = createCodeTool({
    tools: [{ tools: pmTools }, { name: "math", tools: mathTools }],
    executor
  });

  const result = streamText({
    model,
    system: `You are a helpful assistant with access to a codemode tool.
The codemode tool lets you write JavaScript code. You have two namespaces:
- \`codemode\` for weather, projects, and adding numbers
- \`math\` for multiplying and dividing numbers
Keep responses very short (1-2 sentences max).`,
    messages: await convertToModelMessages(body.messages),
    tools: { codemode },
    stopWhen: stepCountIs(5)
  });

  return result.toTextStreamResponse();
}

// ── Fetch handler ─────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/agents/")) {
      return (
        (await routeAgentRequest(request, env)) ||
        new Response("Not found", { status: 404 })
      );
    }

    if (url.pathname === "/run" && request.method === "POST") {
      const agent = await getAgentByName(env.CodemodeAgent, "e2e-test");
      const agentUrl = new URL(request.url);
      agentUrl.pathname = "/chat";
      return agent.fetch(
        new Request(agentUrl.toString(), {
          method: "POST",
          headers: request.headers,
          body: request.body
        })
      );
    }

    if (url.pathname === "/run-multi" && request.method === "POST") {
      return handleRunMulti(request, env);
    }

    if (url.pathname === "/execute" && request.method === "POST") {
      const body = (await request.json()) as ExecuteBody;
      return handleExecute(body, env);
    }

    if (url.pathname === "/mcp/execute" && request.method === "POST") {
      const body = (await request.json()) as { code: string };
      return handleMcpExecute(body, env);
    }

    if (url.pathname === "/types") {
      return Response.json({ types: generateTypes(pmTools) });
    }

    if (url.pathname === "/types/multi") {
      return Response.json({
        types: [generateTypes(pmTools), generateTypes(mathTools, "math")].join(
          "\n\n"
        )
      });
    }

    return new Response("OK");
  }
};
