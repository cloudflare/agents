import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PiExtensionsTestObject } from "./worker";

function fresh(): DurableObjectStub<PiExtensionsTestObject> {
  return env.PI_EXTENSIONS_TEST.getByName(crypto.randomUUID());
}

describe("pi extension surface", () => {
  it("offers an extension tool to the model and runs it", async () => {
    const stub = fresh();
    expect(await stub.toolNames()).toContain("echo");

    const run = await stub.runEcho("hello");
    expect(run).toMatchObject({
      status: "completed",
      output: "echo:hello",
      toolError: false
    });
  });

  it("blocks a tool call from a tool_call handler", async () => {
    const stub = fresh();
    const allowed = await stub.runMultiply(4);
    expect(allowed).toMatchObject({
      status: "completed",
      output: "8",
      toolError: false
    });

    // A blocked call never executes, so pi settles it as an error tool
    // result carrying the handler's reason, with no tool_start/tool_end pair.
    const blocked = await stub.runMultiply(13);
    expect(blocked.status).toBe("completed");
    expect(blocked.output).toContain("unlucky");
    expect(blocked.toolError).toBe(true);

    const events = await stub.events(blocked.operationId);
    expect(events.some((event) => event.type === "tool_start")).toBe(false);
  });

  it("transforms the provider context without touching the transcript", async () => {
    const stub = fresh();
    await stub.runEcho("note");

    const seen = await stub.contextSeen();
    expect(seen.some((text) => text.includes("extension note"))).toBe(true);
    // The flag value the configuration seeded, not the registered default.
    expect(seen.some((text) => text.startsWith("flagged:"))).toBe(true);

    const messages = await stub.messages();
    expect(messages.some((text) => text.includes("extension note"))).toBe(
      false
    );
  });

  it("surfaces a throwing handler as handler_error and finishes the run", async () => {
    const stub = fresh();
    await stub.failMessageEnd(true);
    const run = await stub.runEcho("boom");
    await stub.failMessageEnd(false);

    expect(run.status).toBe("completed");
    const events = await stub.events(run.operationId);
    const errors = events.filter((event) => event.type === "handler_error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatchObject({ message: "message_end handler failed" });
  });

  it("reloads its extensions after an eviction", async () => {
    const stub = fresh();
    expect((await stub.runMultiply(13)).output).toContain("unlucky");

    await evictDurableObject(stub);

    expect(await stub.toolNames()).toContain("echo");
    expect((await stub.runEcho("again")).output).toBe("echo:again");
    expect((await stub.runMultiply(13)).output).toContain("unlucky");
  });
});
