import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { DynamicWorkerExecutor } from "../executor";
import { runCode } from "../run-code";

describe("runCode", () => {
  it("exposes resolved providers as sandbox SDK objects", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await runCode({
      executor,
      code: `async () => {
        return await client.callTool({
          name: "echo",
          arguments: { text: "hello from providers" }
        });
      }`,
      providers: [
        {
          name: "client",
          fns: {
            callTool: async (params: unknown) => params
          }
        }
      ]
    });

    expect(result.result).toEqual({
      name: "echo",
      arguments: { text: "hello from providers" }
    });
  });
});
