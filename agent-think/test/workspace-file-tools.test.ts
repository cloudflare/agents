import { describe, expect, it } from "vitest";
import {
  createReadTool,
  WorkspaceFileStore,
  type WorkspaceLike
} from "../src/tools/fs/index";

const encoder = new TextEncoder();

function workspaceWithFiles(files: Record<string, string>): WorkspaceLike {
  const entries = new Map(
    Object.entries(files).map(([path, content]) => [
      path,
      encoder.encode(content)
    ])
  );
  return {
    fs: {
      async stat(path) {
        const bytes = entries.get(path);
        if (!bytes)
          throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
        return {
          size: bytes.byteLength,
          mtime: 1,
          mode: 0o100644,
          isFile: true,
          isDirectory: false
        };
      },
      async readFile(
        path: string,
        options?: { offset?: number; length?: number }
      ) {
        const bytes = entries.get(path);
        if (!bytes)
          throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
        const start = options?.offset ?? 0;
        const end =
          options?.length === undefined
            ? bytes.byteLength
            : start + options.length;
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.slice(start, end));
            controller.close();
          }
        });
      },
      async writeFile(path, content) {
        entries.set(path, content);
      },
      async mkdir() {},
      async rm(path) {
        entries.delete(path);
      },
      async readdir() {
        return [];
      }
    }
  };
}

describe("Workspace-backed file tools", () => {
  it("reads Think's durable evicted attachments through the model read tool", async () => {
    const path = "/attachments/evicted/message-0.txt";
    const workspace = workspaceWithFiles({
      [path]: "preserved media payload"
    });
    const read = createReadTool({
      store: new WorkspaceFileStore(workspace),
      maxBytes: 1024,
      maxLines: 20
    });

    await expect(
      read.execute!({ path }, undefined as never)
    ).resolves.toMatchObject({
      path,
      content: "preserved media payload",
      truncated: false
    });
  });
});
