import { env } from "cloudflare:workers";
import { getServerByName } from "partyserver";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import type { ThinkTestAgent } from "./agents/think-session";

async function freshAgent(name: string) {
  return getServerByName(
    env.ThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
    name
  );
}

function textOf(message: UIMessage | undefined): string {
  return (message?.parts ?? [])
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

describe("attachment consumption (Phase 5)", () => {
  it("renders a card attachment to the channel", async () => {
    const agent = await freshAgent("attach-card");
    const rendered = await agent.renderAttachment({
      type: "card",
      payload: { hello: "world" }
    });
    expect(rendered).toEqual({
      markdown: expect.stringContaining('"hello": "world"') as unknown as string
    });
  });

  it("renders an email_draft attachment", async () => {
    const agent = await freshAgent("attach-email");
    const rendered = await agent.renderAttachment({
      type: "email_draft",
      subject: "Hi",
      to: ["a@b.com"]
    });
    expect(rendered).toEqual({
      markdown: "**Email draft**\nTo: a@b.com\nSubject: Hi"
    });
  });

  it("ignores voice_note (handled by the voice transport seam) and unknown types", async () => {
    const agent = await freshAgent("attach-ignore");
    expect(
      await agent.renderAttachment({ type: "voice_note" })
    ).toBeUndefined();
    expect(
      await agent.renderAttachment({ type: "mystery", foo: 1 })
    ).toBeUndefined();
  });

  it("delivers known attachments to the channel and skips unknown ones", async () => {
    const agent = await freshAgent("attach-deliver");
    const messages = (await agent.renderAttachmentsForTest([
      { type: "card", payload: { a: 1 } },
      { type: "voice_note" },
      { type: "mystery" }
    ])) as UIMessage[];
    const delivered = messages.filter((m) => m.role === "assistant");
    expect(delivered).toHaveLength(1);
    expect(textOf(delivered[0])).toContain('"a": 1');
  });
});
