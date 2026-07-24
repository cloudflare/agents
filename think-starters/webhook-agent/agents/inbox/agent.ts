import { Think } from "@cloudflare/think";
import { tool } from "ai";
import { z } from "zod";

/**
 * An event-processing agent fed by inbound webhooks.
 *
 * The webhook handler lives in `src/server.ts`: it accepts an external POST,
 * returns immediately, and durably hands the event to this agent with
 * `submitMessages({ idempotencyKey })`. The agent then reasons about the event
 * and acts via tools — here a mocked `notifyTeam`. Because admission is durable
 * and idempotent, a retried or duplicated webhook never starts a second turn.
 */
export class Inbox extends Think<Env> {
  override getModel() {
    // Resolved via the built-in workers-ai-provider off env.AI. Use a
    // "@cf/..." id for Workers AI, or a "provider/model" slug like
    // "openai/gpt-5.5" to route through AI Gateway.
    return "@cf/moonshotai/kimi-k2.7-code";
  }

  /**
   * Durably accept a webhook event and return a receipt. Called from
   * `src/server.ts`. Building the messages inside the agent (rather than passing
   * a `UIMessage[]` across the Worker→DO RPC boundary) keeps the call site
   * simple and the return value a plain, serializable object.
   */
  async ingestEvent(
    idempotencyKey: string,
    event: Record<string, unknown>
  ): Promise<{ submissionId: string; accepted: boolean; status: string }> {
    const submission = await this.submitMessages(
      [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [
            {
              type: "text",
              text: `Inbound event:\n\n${JSON.stringify(event, null, 2)}`
            }
          ]
        }
      ],
      { idempotencyKey, metadata: { source: "webhook" } }
    );
    return {
      submissionId: submission.submissionId,
      accepted: submission.accepted,
      status: submission.status
    };
  }

  override getSystemPrompt() {
    return [
      "You triage inbound system events (webhooks).",
      "For each event, summarize what happened in one line, decide whether a human needs to know, and call notifyTeam when it is urgent.",
      "Be concise. Do not invent details that are not in the event."
    ].join(" ");
  }

  override getTools() {
    return {
      notifyTeam: tool({
        description:
          "Notify the on-call team about an urgent event. Use only when the event genuinely needs human attention.",
        inputSchema: z.object({
          summary: z.string().describe("A one-line summary of the event"),
          severity: z.enum(["info", "warning", "critical"])
        }),
        execute: async ({ summary, severity }) => {
          // Demo only — wire this to Slack, email, PagerDuty, etc.
          return {
            delivered: true,
            severity,
            summary,
            notifiedAt: new Date().toISOString()
          };
        }
      })
    };
  }
}
