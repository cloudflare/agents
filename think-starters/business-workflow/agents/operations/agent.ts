import { Think } from "@cloudflare/think";
import type { ThinkScheduledTasks } from "@cloudflare/think";
import { tool } from "ai";
import { z } from "zod";

type Env = Cloudflare.Env & {
  AI: Ai;
};

/**
 * A back-office operations agent that runs a real business process: look up an
 * account, then take an action that needs human sign-off.
 *
 * Sensitive tools declare `needsApproval`, which pauses the turn at an
 * approval-requested state until a human approves or rejects in the UI
 * (`addToolApprovalResponse`). If the Durable Object is evicted while waiting —
 * a deploy, a timeout — Think parks the turn instead of failing it, and the
 * eventual decision resumes the conversation. A scheduled digest runs the agent
 * proactively even when nobody is connected.
 */
export class Operations extends Think<Env> {
  override getModel() {
    // Resolved via the built-in workers-ai-provider off env.AI. Use a
    // "@cf/..." id for Workers AI, or a "provider/model" slug like
    // "openai/gpt-5.5" to route through AI Gateway.
    return "@cf/moonshotai/kimi-k2.7-code";
  }

  override getSystemPrompt() {
    return [
      "You are a careful back-office operations assistant.",
      "Look up the account before acting. Use issueRefund or closeAccount to act,",
      "and explain what you are about to do before you call them — they require human approval.",
      "Never claim an action succeeded until the tool returns a result."
    ].join(" ");
  }

  override getTools() {
    return {
      lookupAccount: tool({
        description: "Look up a customer account by its ID.",
        inputSchema: z.object({
          accountId: z.string().describe("The account ID, e.g. ACC-4821")
        }),
        execute: async ({ accountId }) => {
          // Demo data — replace with a real lookup (D1, KV, internal API).
          const plans = ["free", "pro", "enterprise"];
          return {
            accountId,
            plan: plans[accountId.length % plans.length],
            monthlySpend: (accountId.length % 5) * 100,
            standing: "good"
          };
        }
      }),

      issueRefund: tool({
        description: "Issue a refund to a customer account.",
        inputSchema: z.object({
          accountId: z.string(),
          amount: z.number().describe("Refund amount in USD"),
          reason: z.string()
        }),
        // Small refunds go through automatically; larger ones need a human.
        needsApproval: async ({ amount }) => amount > 100,
        execute: async ({ accountId, amount, reason }) => {
          // Demo only — wire this to your billing provider.
          return {
            refundId: `rf_${crypto.randomUUID().slice(0, 8)}`,
            accountId,
            amount,
            reason,
            issuedAt: new Date().toISOString()
          };
        }
      }),

      closeAccount: tool({
        description: "Permanently close a customer account.",
        inputSchema: z.object({
          accountId: z.string(),
          reason: z.string()
        }),
        // Irreversible — always require human approval.
        needsApproval: true,
        execute: async ({ accountId, reason }) => {
          // Demo only — wire this to your account system.
          return {
            accountId,
            closed: true,
            reason,
            closedAt: new Date().toISOString()
          };
        }
      })
    };
  }

  override getDefaultTimezone() {
    return "UTC";
  }

  override getScheduledTasks(): ThinkScheduledTasks {
    return {
      dailyDigest: {
        schedule: "every weekday at 17:00",
        prompt:
          "Summarize the operations handled today: refunds issued, accounts closed, and anything still waiting on approval."
      }
    };
  }
}
