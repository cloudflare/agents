import { describe, expect, it } from "vitest";
import { createBashTool } from "../src/tools/bash";

describe("bash tool", () => {
  it("forwards the requested timeout to Workspace/wsd", async () => {
    let received:
      | {
          cwd?: string;
          encoding: "utf8";
          backend?: string;
          timeoutMs?: number;
        }
      | undefined;
    const tool = createBashTool({
      workspace: {
        shell: {
          async exec(_command, options) {
            received = options;
            return {
              async result() {
                return { exitCode: 0, stdout: "ok", stderr: "" };
              }
            };
          }
        }
      },
      backends: { container: { description: "test" } },
      defaultBackend: "container"
    });

    await tool.execute!(
      { command: "pnpm install", timeout: 1200 },
      undefined as never
    );

    expect(received).toMatchObject({
      encoding: "utf8",
      timeoutMs: 1_200_000
    });
  });
});
