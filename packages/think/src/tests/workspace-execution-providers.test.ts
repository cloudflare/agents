import { describe, expect, it } from "vitest";
import type {
  ThinkWorkspace,
  ThinkWorkspaceRuntimeEvent
} from "../workspace/types";
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
          async *[Symbol.asyncIterator]() {
            yield {
              name: "stdout",
              value: "ok"
            } satisfies ThinkWorkspaceRuntimeEvent;
            yield {
              name: "exit",
              code: 0
            } satisfies ThinkWorkspaceRuntimeEvent;
          },
          async result() {
            return { exitCode: 0, stdout: "ok", stderr: "" };
          }
        };
      }
    }
  };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" && value !== null && Symbol.asyncIterator in value
  );
}

describe("Bash workspace tools", () => {
  it("preserves streamed Worker Shell tool output", async () => {
    const calls: Array<{ source: string; options: Record<string, unknown> }> =
      [];
    const tools = createBashWorkspaceTools(
      executableWorkspace((source, options) => calls.push({ source, options })),
      { backendId: "shell" }
    );

    expect(Object.keys(tools)).toEqual(["bash"]);
    const execution = tools.bash.execute?.({ command: "pwd" }, toolContext);
    expect(isAsyncIterable(execution)).toBe(true);

    const output: unknown[] = [];
    if (isAsyncIterable(execution)) {
      for await (const event of execution) output.push(event);
    }

    expect(output.at(-1)).toEqual({
      command: "pwd",
      cwd: null,
      backend: "shell",
      exitCode: 0,
      stdout: "ok",
      stderr: ""
    });
    expect(calls).toEqual([
      {
        source: "pwd",
        options: {
          backend: "shell",
          encoding: "utf8",
          env: undefined,
          input: undefined
        }
      }
    ]);
  });
});
