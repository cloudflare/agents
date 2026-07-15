/**
 * Ported from ORIGINAL Think:
 * - packages/think/src/tests/deliver-notice.test.ts
 * - last original change: unknown
 * - port date: 2026-07-15
 * Modifications:
 * - Re-pointed `partyserver` import to `./compat.js`.
 * - Re-pointed original fixture type import to `./fixtures/index.js`.
 * - Added `@ts-nocheck` because one original assertion passes the legacy
 *   markdown payload shape, while the rebuild currently types `deliverNotice`
 *   as string-only.
 */
// @ts-nocheck
import { env } from "cloudflare:workers";
import { getServerByName } from "./compat.js";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import type { ThinkTestAgent } from "./fixtures/index.js";

async function freshAgent(name: string) {
  return getServerByName(
    env.ThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
    name
  );
}

function lastMessage(messages: UIMessage[]): UIMessage | undefined {
  return messages[messages.length - 1];
}

function textOf(message: UIMessage | undefined): string {
  return (message?.parts ?? [])
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

describe("deliverNotice", () => {
  it("appends a plain web notice to the transcript when informModel is false", async () => {
    const agent = await freshAgent("notice-web-plain");
    await agent.deliverNotice("background job started");
    const messages = (await agent.getStoredMessages()) as UIMessage[];
    const last = lastMessage(messages);
    expect(last?.role).toBe("assistant");
    expect(textOf(last)).toBe("background job started");
  });

  it("annotates the web notice when informModel is true", async () => {
    const agent = await freshAgent("notice-web-inform");
    await agent.deliverNotice("started a background agent", {
      informModel: true
    });
    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(textOf(lastMessage(messages))).toBe(
      "[Delivered to the user out of band] started a background agent"
    );
  });

  it("accepts a markdown payload", async () => {
    const agent = await freshAgent("notice-web-markdown");
    await agent.deliverNotice({ markdown: "**done**" });
    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(textOf(lastMessage(messages))).toBe("**done**");
  });

  it("records the delivery kind on the notice message metadata", async () => {
    const agent = await freshAgent("notice-web-kind");
    await agent.deliverNotice("typing…", { kind: "command" });
    const messages = (await agent.getStoredMessages()) as UIMessage[];
    const last = lastMessage(messages) as
      | (UIMessage & { metadata?: { deliveryKind?: string } })
      | undefined;
    expect(last?.metadata?.deliveryKind).toBe("command");
  });

  it("defaults the delivery kind to notice", async () => {
    const agent = await freshAgent("notice-web-default-kind");
    await agent.deliverNotice("fyi");
    const messages = (await agent.getStoredMessages()) as UIMessage[];
    const last = lastMessage(messages) as
      | (UIMessage & { metadata?: { deliveryKind?: string } })
      | undefined;
    expect(last?.metadata?.deliveryKind).toBe("notice");
  });

  it("does not start a model turn (notices are assistant-only, no user turn)", async () => {
    const agent = await freshAgent("notice-no-turn");
    await agent.deliverNotice("note one");
    await agent.deliverNotice("note two");
    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.role === "assistant")).toBe(true);
  });

  it("throws when a named channel cannot be resolved (fail fast)", async () => {
    const agent = await freshAgent("notice-bad-channel");
    const error = await agent.deliverNoticeErrorForTest("hi", "telegram");
    expect(error).toMatch(/cannot resolve a delivery surface/);
  });
});
