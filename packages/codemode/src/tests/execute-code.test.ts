import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { DynamicWorkerExecutor } from "../executor";
import { executeCode } from "../execute-code";

describe("executeCode", () => {
  it("exposes globals as sandbox SDK objects", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executeCode({
      executor,
      code: `async () => {
        return await client.callTool({
          name: "echo",
          arguments: { text: "hello from globals" }
        });
      }`,
      globals: {
        client: {
          callTool: async (params: unknown) => params
        }
      }
    });

    expect(result.result).toEqual({
      name: "echo",
      arguments: { text: "hello from globals" }
    });
  });
});
