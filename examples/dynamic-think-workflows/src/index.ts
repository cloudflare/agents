import { getAgentByName, routeAgentRequest } from "agents";
import { createWorkersAI } from "workers-ai-provider";
import { Think } from "@cloudflare/think";
import { DynamicThinkWorkflow } from "@cloudflare/think/dynamic-workflows";

export { DynamicThinkWorkflow };

type Env = {
  AI: Ai;
  LOADER: WorkerLoader;
  MyAgent: DurableObjectNamespace<MyAgent>;
  DYNAMIC_THINK_WF: Workflow;
};

/**
 * A simple Think agent that can launch dynamic workflows.
 */
export class MyAgent extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.7-code"
    );
  }

  getSystemPrompt() {
    return "You are a helpful assistant.";
  }

  /**
   * Generate and run a dynamic ThinkWorkflow.
   * In a real app, this code could be LLM-generated, loaded from a DB,
   * or authored by users at runtime.
   */
  async startDynamicWorkflow(topic: string): Promise<{ workflowId: string }> {
    const code = generateWorkflowCode();
    const workflowId = await this.runDynamicWorkflow("DYNAMIC_THINK_WF", code, {
      topic
    });
    return { workflowId };
  }
}

/**
 * Generate a ThinkWorkflow class as a TypeScript string.
 *
 * The generated code extends ThinkWorkflow and uses step.prompt() for
 * durable LLM calls. It's bundled at runtime by worker-bundler and
 * executed as a Dynamic Worker.
 */
function generateWorkflowCode(): string {
  return `
import { ThinkWorkflow } from "@cloudflare/think/workflows";
import type { ThinkWorkflowStep } from "@cloudflare/think/workflows";
import type { AgentWorkflowEvent } from "agents/workflows";
import { z } from "zod";

type Params = { topic: string };

const summarySchema = z.object({
  title: z.string(),
  summary: z.string(),
  keyPoints: z.array(z.string())
});

export default class GeneratedWorkflow extends ThinkWorkflow {
  async run(
    event: AgentWorkflowEvent<Params>,
    step: ThinkWorkflowStep
  ): Promise<void> {
    const result = await step.prompt("analyze", {
      prompt: "Write a brief analysis about: " + event.payload.topic,
      output: summarySchema,
      timeout: "3 minutes"
    });

    await step.do("save-result", async () => {
      console.log("Analysis complete:", JSON.stringify(result, null, 2));
    });
  }
}
`.trim();
}

async function getDefaultAgent(env: Env) {
  return getAgentByName(env.MyAgent, "default");
}

export default {
  async fetch(request: Request, env: Env) {
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/run") {
      const body = (await request.json()) as { topic?: unknown };
      if (typeof body.topic !== "string" || body.topic.trim() === "") {
        return Response.json(
          { error: "Expected JSON body with 'topic' field" },
          { status: 400 }
        );
      }
      const agent = await getDefaultAgent(env);
      const result = await agent.startDynamicWorkflow(body.topic);
      return Response.json(result);
    }

    return Response.json(
      {
        routes: ["POST /run { topic: string } — start a dynamic ThinkWorkflow"]
      },
      { status: 404 }
    );
  }
} satisfies ExportedHandler<Env>;
