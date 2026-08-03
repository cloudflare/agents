import { describe, expect, it } from "vitest";
import { adaptComputer, type WorkspaceClient } from "../experimental/computer";
import { Think } from "../think";
import { createWorkspaceTools } from "../tools/workspace";

const toolContext = {
  toolCallId: "test",
  messages: [],
  abortSignal: new AbortController().signal,
  context: {}
};

type FakeComputer = WorkspaceClient & {
  ready?(): Promise<void>;
  stub?(): object;
};

function createFakeComputer(options?: {
  onExec?: (command: string, cwd: string | undefined) => void;
  onReady?: () => void;
  stub?: object;
}): FakeComputer {
  const files = new Map<string, Uint8Array>();
  const directories = new Set(["/"]);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function missing(path: string): Error {
    return Object.assign(new Error(`missing: ${path}`), {
      code: "ENOENT",
      path
    });
  }

  function name(path: string): string {
    return path === "/" ? "" : (path.split("/").pop() ?? "");
  }

  function parent(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash <= 0 ? "/" : path.slice(0, slash);
  }

  function stat(path: string) {
    if (!files.has(path) && !directories.has(path)) throw missing(path);
    return {
      name: name(path),
      size: files.get(path)?.byteLength ?? 0,
      mtime: 123,
      isFile: files.has(path),
      isDirectory: directories.has(path),
      isSymbolicLink: false
    };
  }

  function readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  function readFile(path: string, encoding: "utf8"): Promise<string>;
  async function readFile(
    path: string,
    encoding?: "utf8"
  ): Promise<string | ReadableStream<Uint8Array>> {
    const content = files.get(path);
    if (!content) throw missing(path);
    if (encoding === "utf8") return decoder.decode(content);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(content);
        controller.close();
      }
    });
  }

  const runtime = {
    async exec(command: string, execOptions?: { cwd?: string }) {
      options?.onExec?.(command, execOptions?.cwd);
      return {
        async result() {
          return {
            exitCode: 0,
            stdout: "from computer\n",
            stderr: ""
          };
        }
      };
    }
  } as WorkspaceClient["runtime"];

  return {
    fs: {
      readFile,
      async stat(path: string) {
        return stat(path);
      },
      async readdir(path: string) {
        if (!directories.has(path)) throw missing(path);
        const children = [
          ...new Set(
            [...files.keys(), ...directories]
              .filter((candidate) => candidate !== path)
              .filter((candidate) => parent(candidate) === path)
          )
        ];
        return children.map((child) => ({
          name: name(child),
          parentPath: path,
          isFile: files.has(child),
          isDirectory: directories.has(child),
          isSymbolicLink: false
        }));
      },
      async find(_directory: string, pattern?: string) {
        const suffix = pattern?.split("*").pop() ?? "";
        return [...files.keys()]
          .filter((path) => path.endsWith(suffix))
          .map((path) => ({ path, type: "file" as const }));
      },
      async writeFile(path: string, content: string | Uint8Array) {
        files.set(
          path,
          typeof content === "string" ? encoder.encode(content) : content
        );
      },
      async mkdir(path: string, mkdirOptions?: { recursive?: boolean }) {
        if (mkdirOptions?.recursive) {
          const parts = path.split("/").filter(Boolean);
          let current = "";
          for (const part of parts) {
            current += `/${part}`;
            directories.add(current);
          }
        } else {
          directories.add(path);
        }
      },
      async rm(
        path: string,
        rmOptions?: { recursive?: boolean; force?: boolean }
      ) {
        if (
          !files.delete(path) &&
          !directories.delete(path) &&
          !rmOptions?.force
        ) {
          throw missing(path);
        }
        if (rmOptions?.recursive) {
          for (const candidate of [...files.keys()]) {
            if (candidate.startsWith(`${path}/`)) files.delete(candidate);
          }
          for (const candidate of [...directories]) {
            if (candidate.startsWith(`${path}/`)) directories.delete(candidate);
          }
        }
      }
    } as unknown as WorkspaceClient["fs"],
    runtime,
    async readFile() {
      return null;
    },
    async readFileBytes() {
      return null;
    },
    async writeFile() {},
    async readDir() {
      return [];
    },
    async rm() {},
    async glob() {
      return [];
    },
    async mkdir() {},
    async stat() {
      return null;
    },
    git: {},
    assets: undefined,
    artifacts: {},
    ready: options?.onReady
      ? async () => {
          options.onReady?.();
        }
      : undefined,
    stub: options?.stub ? () => options.stub! : undefined,
    [Symbol.dispose]() {}
  };
}

describe("experimental Computer workspace", () => {
  it("preserves the upstream Computer client", () => {
    const computer = createFakeComputer();

    expect(adaptComputer(computer)).toBe(computer);
  });

  it("rejects clients whose owner did not enable useThink", () => {
    const computer = createFakeComputer();
    delete computer.readFile;

    expect(() => adaptComputer(computer)).toThrow(
      "Construct its Workspace with useThink: true"
    );
  });

  it("uses Computer shell exec for the built-in bash tool", async () => {
    const calls: Array<{ command: string; cwd: string | undefined }> = [];
    const workspace = adaptComputer(
      createFakeComputer({
        onExec(command, cwd) {
          calls.push({ command, cwd });
        }
      })
    );
    const bash = createWorkspaceTools(workspace).bash;

    const result = await bash?.execute?.({ script: "pwd" }, toolContext);

    expect(calls).toEqual([{ command: "pwd", cwd: "/workspace" }]);
    expect(result).toEqual({
      exitCode: 0,
      stdout: "from computer\n",
      stderr: ""
    });
  });

  it("provides the local stub used by WorkspaceServiceProxy", async () => {
    const stub = { kind: "workspace-stub" };
    let ready = false;
    const workspace = adaptComputer(
      createFakeComputer({
        onReady() {
          ready = true;
        },
        stub
      })
    );

    const host = { workspace } as unknown as Think;
    await expect(Think.prototype.__getWorkspaceStub.call(host)).resolves.toBe(
      stub
    );
    expect(ready).toBe(true);
  });
});
