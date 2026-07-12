import { describe, expect, it } from "vitest";
import { createMemoryEmailTransport } from "./email.js";

describe("createMemoryEmailTransport", () => {
  it("records sent messages", async () => {
    const transport = createMemoryEmailTransport();
    await transport.send({ from: "a@example.com", to: "b@example.com", subject: "hi", text: "hello" });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({ from: "a@example.com", to: "b@example.com", subject: "hi" });
  });

  it("returns a messageId for each send", async () => {
    const transport = createMemoryEmailTransport();
    const result = await transport.send({ from: "a@example.com", to: "b@example.com" });
    expect(typeof result.messageId).toBe("string");
    expect(result.messageId.length).toBeGreaterThan(0);
  });

  it("assigns distinct messageIds across sends", async () => {
    const transport = createMemoryEmailTransport();
    const first = await transport.send({ from: "a@example.com", to: "b@example.com" });
    const second = await transport.send({ from: "a@example.com", to: "b@example.com" });
    expect(first.messageId).not.toBe(second.messageId);
  });

  it("stores the assigned messageId alongside the recorded message", async () => {
    const transport = createMemoryEmailTransport();
    const result = await transport.send({ from: "a@example.com", to: "b@example.com" });
    expect(transport.sent[0]?.messageId).toBe(result.messageId);
  });
});
