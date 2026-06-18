import { Think, skills } from "@cloudflare/think";
import { createWorkersAI } from "workers-ai-provider";
import bundledSkills from "agents:skills";
import { tool } from "ai";
import { z } from "zod";

type Env = Cloudflare.Env & {
  AI: Ai;
  LOADER: WorkerLoader;
};

/**
 * A customer support agent.
 *
 * `getTools` adds domain tools alongside the built-in workspace tools — here a
 * mocked order lookup. The colocated `escalation` skill teaches the model how
 * and when to hand a conversation off to a human. Wire the tools up to your
 * real systems (D1, an internal API, etc.) to make it production-ready.
 */
export class Support extends Think<Env> {
  override getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.7-code",
      {
        sessionAffinity: this.sessionAffinity
      }
    );
  }

  override getSystemPrompt() {
    return "You are a friendly customer support agent. Be concise and helpful. Use the lookupOrder tool when a customer asks about an order, and follow the escalation skill when a request needs a human.";
  }

  override getTools() {
    return {
      lookupOrder: tool({
        description: "Look up the status of a customer order by its ID.",
        inputSchema: z.object({
          orderId: z.string().describe("The order ID, e.g. ORD-1234")
        }),
        execute: async ({ orderId }) => {
          // Demo data — replace with a real lookup (D1, KV, internal API).
          const statuses = ["processing", "shipped", "delivered", "refunded"];
          const status = statuses[orderId.length % statuses.length];
          return { orderId, status, updatedAt: new Date().toISOString() };
        }
      })
    };
  }

  override getSkills() {
    return [bundledSkills];
  }

  override getSkillScriptRunner() {
    return skills.runner({
      loader: this.env.LOADER,
      workspaceInstance: this.workspace
    });
  }
}
