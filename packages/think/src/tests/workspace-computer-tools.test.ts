import { describe, expect, it } from "vitest";
import { createWorkspaceTools } from "../tools/workspace";
import type { ThinkWorkspace } from "../workspace";

const toolContext = {
  toolCallId: "test",
  messages: [],
  abortSignal: new AbortController().signal,
  context: {}
};

function computerWorkspace(
  onFind?: (directory: string, pattern?: string) => void
): ThinkWorkspace {
  const files = new Map<string, string>([["/notes.txt", "hello"]]);
  return {
    fs: {
      async readFile(path: string, encoding?: "utf8") {
        const content = files.get(path);
        if (content === undefined) {
          throw Object.assign(new Error(`missing: ${path}`), {
            code: "ENOENT"
          });
        }
        if (encoding === "utf8") return content;
        return new Response(content).body!;
      },
      async stat(path: string) {
        const content = files.get(path);
        if (content === undefined) {
          throw Object.assign(new Error(`missing: ${path}`), {
            code: "ENOENT"
          });
        }
        return {
          name: path.split("/").pop()!,
          inode: 1,
          mode: 0o100644,
          mtime: 1,
          size: content.length,
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false
        };
      },
      async readdir() {
        return [];
      },
      async find(directory: string, pattern?: string) {
        onFind?.(directory, pattern);
        return [...files.keys()].map((path) => ({
          path,
          type: "file" as const
        }));
      },
      async writeFile(path: string, content: string | Uint8Array) {
        files.set(
          path,
          typeof content === "string"
            ? content
            : new TextDecoder().decode(content)
        );
      },
      async mkdir() {},
      async rm(path: string) {
        files.delete(path);
      }
    } as unknown as ThinkWorkspace["fs"],
    runtime: {
      async exec() {
        throw new Error("no backend configured");
      }
    }
  };
}

describe("Computer workspace tools", () => {
  it("adds file tools without inferring execution from runtime", async () => {
    const tools = createWorkspaceTools(computerWorkspace());

    expect(Object.keys(tools)).toEqual([
      "read",
      "write",
      "edit",
      "list",
      "find",
      "grep",
      "delete"
    ]);

    await expect(
      tools.read.execute?.({ path: "/notes.txt" }, toolContext)
    ).resolves.toMatchObject({ path: "/notes.txt", totalLines: 1 });
  });

  it("resolves relative find and grep patterns from the workspace root", async () => {
    const calls: Array<[string, string | undefined]> = [];
    const tools = createWorkspaceTools(
      computerWorkspace((directory, pattern) =>
        calls.push([directory, pattern])
      )
    );

    await expect(
      tools.find.execute?.({ pattern: "**/*.txt" }, toolContext)
    ).resolves.toMatchObject({ files: ["/notes.txt"] });
    await expect(
      tools.grep.execute?.({ query: "hello", include: "**/*.txt" }, toolContext)
    ).resolves.toMatchObject({ totalMatches: 1 });

    expect(calls).toEqual([
      ["/", "**/*.txt"],
      ["/", "**/*.txt"]
    ]);
  });

  it("preserves common media types for multimodal reads", async () => {
    const tools = createWorkspaceTools(computerWorkspace());
    await tools.write.execute?.(
      { path: "/image.png", content: "image bytes" },
      toolContext
    );

    await expect(
      tools.read.execute?.({ path: "/image.png" }, toolContext)
    ).resolves.toMatchObject({
      kind: "image",
      mediaType: "image/png"
    });
  });

  it("returns the existing not-found result for Computer ENOENT errors", async () => {
    const tools = createWorkspaceTools(computerWorkspace());

    await expect(
      tools.read.execute?.({ path: "/missing.txt" }, toolContext)
    ).resolves.toEqual({ error: "File not found: /missing.txt" });
  });
});
