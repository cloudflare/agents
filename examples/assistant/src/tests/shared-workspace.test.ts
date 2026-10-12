/**
 * Shared workspace round-trip tests.
 *
 * This is the headline assertion of the multi-session design: a file
 * written inside chat A is visible verbatim inside chat B, because both
 * `MyAssistant` facets reach the directory's single `Workspace` through
 * `getWorkspace()` from `@cloudflare/computer`. Each chat resolves it
 * lazily on first use (`lazyWorkspace`), then forwards each operation
 * over one DO RPC hop.
 *
 * We write through the directory's workspace client (the same
 * `getWorkspace()` door the chats use) and read through `MyAssistant`'s
 * own `@callable()` surface (`listWorkspaceFiles`, `readWorkspaceFile`),
 * using `getSubAgentByName` to address the child facets without going
 * through HTTP/WS.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName, getSubAgentByName } from "agents";
import { getWorkspace, type WorkspaceHandle } from "@cloudflare/computer";
import { uniqueDirectoryName } from "./helpers";
import { MyAssistant } from "../../agents/assistant/agents/my-assistant/agent";
import type { AssistantDirectory } from "../../agents/assistant/agent";

const encoder = new TextEncoder();

async function writeShared(
  directory: DurableObjectStub<AssistantDirectory>,
  path: string,
  content: string
): Promise<void> {
  // SAFETY: AssistantDirectory implements `__getWorkspaceStub()`. The DO stub
  // types its result as `Stub<WorkspaceStub>`, which TypeScript cannot relate
  // to WorkspaceHandle's `WorkspaceStub`.
  using workspace = await getWorkspace(directory as unknown as WorkspaceHandle);
  const parent = path.slice(0, path.lastIndexOf("/"));
  if (parent) await workspace.fs.mkdir(parent, { recursive: true });
  await workspace.fs.writeFile(path, encoder.encode(content));
}

describe("shared workspace — cross-chat round-trip", () => {
  it("file written inside chat A is visible inside chat B", async () => {
    const directory = await getAgentByName(
      env.AssistantDirectory,
      uniqueDirectoryName()
    );
    const a = await directory.createChat({ title: "A" });
    const b = await directory.createChat({ title: "B" });

    const childA = await getSubAgentByName(directory, MyAssistant, a.id);
    const childB = await getSubAgentByName(directory, MyAssistant, b.id);

    await writeShared(
      directory,
      "/workspace/notes/hello.txt",
      "hi from chat A"
    );

    const contents = await childB.readWorkspaceFile(
      "/workspace/notes/hello.txt"
    );
    expect(contents).toBe("hi from chat A");

    const filesA = await childA.listWorkspaceFiles("/workspace/notes");
    const filesB = await childB.listWorkspaceFiles("/workspace/notes");
    expect(filesA.map((f) => f.name)).toEqual(["hello.txt"]);
    expect(filesB.map((f) => f.name)).toEqual(["hello.txt"]);
    expect(filesB[0]).toMatchObject({ type: "file", size: 14 });

    // The file panel lists the default root, /workspace.
    const root = await childB.listWorkspaceFiles();
    expect(root.map((f) => f.name)).toEqual(["notes"]);
  });

  it("readWorkspaceFile returns null for a missing path", async () => {
    const directory = await getAgentByName(
      env.AssistantDirectory,
      uniqueDirectoryName()
    );
    const { id } = await directory.createChat();
    const child = await getSubAgentByName(directory, MyAssistant, id);

    const result = await child.readWorkspaceFile("/never-written.txt");
    expect(result).toBeNull();
  });

  it("listWorkspaceFiles returns an empty list for a missing directory", async () => {
    const directory = await getAgentByName(
      env.AssistantDirectory,
      uniqueDirectoryName()
    );
    const { id } = await directory.createChat();
    const child = await getSubAgentByName(directory, MyAssistant, id);

    const result = await child.listWorkspaceFiles("/does/not/exist");
    expect(result).toEqual([]);
  });
});
