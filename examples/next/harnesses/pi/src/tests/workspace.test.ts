import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/**
 * `createWorkspaceTools` adapts Computer's workspace tools to pi-durable.
 * pi gives the model only the result's `output`, so a tool whose result
 * the adapter drops leaves the model an empty reply.
 */
describe("the workspace tools", () => {
  it("give the model the file a read returns", async () => {
    const stub = env.PI_HARNESS_TEST.getByName(crypto.randomUUID());
    await stub.writeWorkspaceFile("/workspace/notes.txt", "remember the milk");
    const result = await stub.prompt("read /workspace/notes.txt");
    expect(result.status).toBe("done");
    expect(result.text).toMatch(/^tool said: .*remember the milk/s);
  });
});
