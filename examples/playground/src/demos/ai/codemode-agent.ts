import { createWorkersAI } from "workers-ai-provider";
import { AIChatAgent } from "@cloudflare/ai-chat";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  tool,
  stepCountIs
} from "ai";
import { createCodeTool } from "@cloudflare/codemode/ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { z } from "zod";

const pmTools = {
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
      temperature: Math.floor(Math.random() * 30) + 5,
      condition: ["sunny", "cloudy", "rainy"][Math.floor(Math.random() * 3)]
    })
  }),

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
  })
};

export class CodemodeAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 200;

  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const executor = new DynamicWorkerExecutor({
      loader: this.env.LOADER
    });

    const codemode = createCodeTool({ tools: pmTools, executor });

    const result = streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      system:
        "You are a helpful assistant with access to a codemode tool. " +
        "When asked to perform operations, use the codemode tool to write JavaScript code " +
        "that calls the available functions on the `codemode` object. " +
        "Keep responses short.",
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: { codemode },
      stopWhen: stepCountIs(5)
    });

    return result.toUIMessageStreamResponse();
  }
}
