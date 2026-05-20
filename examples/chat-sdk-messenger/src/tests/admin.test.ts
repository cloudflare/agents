import { env, exports } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { ChatIngressAgent } from "../index";

type TestEnv = typeof env & {
  ChatIngressAgent: DurableObjectNamespace<ChatIngressAgent>;
};

function uniqueName(): string {
  return `chat-sdk-admin-${crypto.randomUUID()}`;
}

describe("ChatIngressAgent admin surface", () => {
  it("reports setup state and empty admin lists", async () => {
    const agent = (await getAgentByName(
      (env as TestEnv).ChatIngressAgent,
      uniqueName()
    )) as unknown as ChatIngressAgent;

    await expect(agent.getSetupInfo()).resolves.toMatchObject({
      webhookPath: "/webhooks/telegram",
      agentName: "default",
      telegramConfigured: false
    });
    await expect(agent.listConversations()).resolves.toEqual([]);
    await expect(agent.listReplyJobs()).resolves.toEqual([]);
  });

  it("rejects browser access to unknown conversation subagents", async () => {
    const name = uniqueName();
    await getAgentByName((env as TestEnv).ChatIngressAgent, name);

    const response = await exports.default.fetch(
      `http://example.com/agents/chat-ingress-agent/${name}/sub/conversation-agent/unknown`
    );

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toContain(
      'Conversation "unknown" not found'
    );
  });

  it("requires Telegram credentials before setting the webhook", async () => {
    const response = await exports.default.fetch(
      "https://example.com/setup/telegram-webhook",
      { method: "POST" }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "TELEGRAM_BOT_TOKEN is not configured."
    });
  });

  it("requires HTTPS before calling Telegram webhook setup", async () => {
    const response = await exports.default.fetch(
      "http://example.com/setup/telegram-webhook",
      { method: "POST" }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      webhookUrl: "http://example.com/webhooks/telegram",
      error:
        "Telegram webhooks require HTTPS. Open the Quick Tunnel or deployed Worker URL and click Set webhook here again."
    });
  });
});
