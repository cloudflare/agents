import { describe, expect, it } from "vitest";
import type { ThinkWorkspace } from "../workspace/types";
import { createBashWorkspaceTools } from "../workspace/workspace-bash";

const toolContext = {
  toolCallId: "test",
  messages: [],
  abortSignal: new AbortController().signal,
  context: {}
};

function executableWorkspace(
  onExec: (source: string, options: Record<string, unknown>) => void
): ThinkWorkspace {
  return {
    fs: {
      async mkdir() {}
    } as unknown as ThinkWorkspace["fs"],
    runtime: {
      async exec(source, options) {
        onExec(source, options ?? {});
        return {
          async result() {
            return { exitCode: 0, stdout: "ok", stderr: "" };
          }
        };
      }
    }
  };
}

describe("Bash workspace tools", () => {
  it("provides Worker Shell as a turn-level bash tool", async () => {
    const calls: Array<{ source: string; options: Record<string, unknown> }> =
      [];
    const tools = createBashWorkspaceTools(
      executableWorkspace((source, options) => calls.push({ source, options })),
      { backendId: "shell" }
    );

    expect(Object.keys(tools)).toEqual(["bash"]);
    await tools.bash.execute?.({ command: "pwd" }, toolContext);
    expect(calls).toEqual([
      {
        source: "pwd",
        options: { backend: "shell", encoding: "utf8" }
      }
    ]);
  });
});
