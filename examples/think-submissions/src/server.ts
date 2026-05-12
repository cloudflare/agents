import { callable, routeAgentRequest } from "agents";
import { createWorkersAI } from "workers-ai-provider";
import { Think } from "@cloudflare/think";
import type {
  ThinkSubmissionInspection,
  ThinkSubmissionStatus
} from "@cloudflare/think";

type Env = {
  AI: Ai;
  TaskAgent: DurableObjectNamespace<TaskAgent>;
};

export class TaskAgent extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.6"
    );
  }

  getSystemPrompt() {
    return [
      "You are a background task assistant.",
      "Respond with a concise status update and the final answer for the submitted task."
    ].join("\n");
  }

  @callable()
  async submitTask(prompt: string, idempotencyKey?: string) {
    const key = idempotencyKey?.trim() || undefined;
    return this.submitMessages(
      [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: prompt }]
        }
      ],
      {
        idempotencyKey: key,
        metadata: { source: "example", promptPreview: prompt.slice(0, 120) }
      }
    );
  }

  @callable()
  async inspectTask(
    submissionId: string
  ): Promise<ThinkSubmissionInspection | null> {
    return this.inspectSubmission(submissionId);
  }

  @callable()
  async listTasks(status?: ThinkSubmissionStatus) {
    return this.listSubmissions({ status, limit: 25 });
  }

  @callable()
  async cancelTask(submissionId: string) {
    await this.cancelSubmission(submissionId, "Cancelled from dashboard");
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
