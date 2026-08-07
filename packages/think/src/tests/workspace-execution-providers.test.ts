import { describe, expect, it } from "vitest";
import { workspaceToolProvider, type ThinkWorkspace } from "../workspace";
import { createWorkspaceConnector } from "../tools/execute";
import { createShellWorkspaceTools } from "../workspace-shell";

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
      async mkdir() {},
      async readdir() {
        return [];
      }
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

describe("workspace execution providers", () => {
  it("provides Worker Shell as bash", async () => {
    const calls: Array<{ source: string; options: Record<string, unknown> }> =
      [];
    const tools = createShellWorkspaceTools(
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

  it("exposes the Think workspace tools as a codemode connector", async () => {
    const connector = createWorkspaceConnector(
      {
        waitUntil() {},
        passThroughOnException() {}
      } as unknown as ExecutionContext,
      executableWorkspace(() => undefined)
    );

    await expect(connector.describe()).resolves.toMatchObject({
      name: "workspace",
      descriptors: {
        read: {},
        list: {},
        write: {},
        edit: {}
      },
      annotations: {
        read: { replay: "reexecute" },
        list: { replay: "reexecute" }
      }
    });
    await expect(
      connector.executeTool("list", { path: "/" })
    ).resolves.toMatchObject({ entries: [] });
  });

  it("uses branded providers on configured workspace instances", async () => {
    const workspace = executableWorkspace(() => undefined) as ThinkWorkspace & {
      [workspaceToolProvider]: () => ReturnType<
        typeof createShellWorkspaceTools
      >;
    };
    workspace[workspaceToolProvider] = () =>
      createShellWorkspaceTools(workspace, { backendId: "shell" });

    expect(Object.keys(workspace[workspaceToolProvider]())).toEqual(["bash"]);

    const connector = createWorkspaceConnector(
      {
        waitUntil() {},
        passThroughOnException() {}
      } as unknown as ExecutionContext,
      workspace
    );
    const description = await connector.describe();
    expect(Object.keys(description.descriptors)).toEqual([
      "read",
      "write",
      "edit",
      "list",
      "bash"
    ]);
    expect(description.descriptors).not.toHaveProperty("ls");
    expect(description.descriptors).not.toHaveProperty("exec");
  });
});
