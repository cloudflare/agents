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
import { createCodeTool } from "../src/ai";
import { DynamicWorkerExecutor, generateTypes } from "../src/index";

type Env = {
  AI: Ai;
  LOADER: WorkerLoader;
  CodemodeAgent: DurableObjectNamespace<CodemodeAgent>;
};

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

export class CodemodeAgent extends Agent<Env> {
  observability = undefined;

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
    // @ts-expect-error — model not yet in workers-ai-provider types
    const model = workersai("@cf/zai-org/glm-4.7-flash");

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

    if (url.pathname === "/types") {
      return Response.json({ types: generateTypes(pmTools) });
    }

    return new Response("OK");
  }
};
