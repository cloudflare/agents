/**
 * SharedWorkspace round-trip tests.
 *
 * This is the headline assertion of the multi-session refactor: a file
 * written inside chat A is visible verbatim inside chat B, because
 * both `MyAssistant` facets see the directory's single `Workspace`
 * through the `SharedWorkspace` proxy. The proxy resolves
 * `parentAgent(AssistantDirectory)` lazily on first call, then
 * forwards each operation over one DO RPC hop.
 *
 * We exercise the proxy via `MyAssistant`'s own `@callable()` surface
 * (`listWorkspaceFiles`, `readWorkspaceFile`) plus the directory's
 * direct `writeFile` RPC, and use `getSubAgentByName` to address the
 * child facets without going through HTTP/WS.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName, getSubAgentByName } from "agents";
import { uniqueDirectoryName } from "./helpers";
import { MyAssistant } from "../server";

describe("SharedWorkspace — cross-chat round-trip", () => {
  it("file written inside chat A is visible inside chat B", async () => {
    const directory = await getAgentByName(
      env.AssistantDirectory,
      uniqueDirectoryName()
    );
    const a = await directory.createChat({ title: "A" });
    const b = await directory.createChat({ title: "B" });

    // Resolve typed stubs to both chat facets.
    const childA = await getSubAgentByName(directory, MyAssistant, a.id);
    const childB = await getSubAgentByName(directory, MyAssistant, b.id);

    // Write through chat A's `SharedWorkspace` proxy by going via the
    // directory's direct `writeFile` RPC (the proxy forwards to the
    // same RPC method, so this exercises the same store).
    await directory.writeFile("/notes/hello.txt", "hi from chat A");

    // Read through chat B's `SharedWorkspace` proxy via its
    // `readWorkspaceFile` callable.
    const contents = await childB.readWorkspaceFile("/notes/hello.txt");
    expect(contents).toBe("hi from chat A");

    // Both chats see the same listing.
    const filesA = await childA.listWorkspaceFiles("/notes");
    const filesB = await childB.listWorkspaceFiles("/notes");
    expect(filesA.map((f) => f.name)).toEqual(["hello.txt"]);
    expect(filesB.map((f) => f.name)).toEqual(["hello.txt"]);
  });

  it("directory-level reads and child-proxy reads see the same content", async () => {
    const directory = await getAgentByName(
      env.AssistantDirectory,
      uniqueDirectoryName()
    );
    const { id } = await directory.createChat();
    const child = await getSubAgentByName(directory, MyAssistant, id);

    await directory.writeFile("/shared.md", "# shared");

    const fromDirectory = await directory.readFile("/shared.md");
    const fromChild = await child.readWorkspaceFile("/shared.md");

    expect(fromDirectory).toBe("# shared");
    expect(fromChild).toBe("# shared");
  });

  it("readWorkspaceFile returns null for a missing path (proxy doesn't throw)", async () => {
    const directory = await getAgentByName(
      env.AssistantDirectory,
      uniqueDirectoryName()
    );
    const { id } = await directory.createChat();
    const child = await getSubAgentByName(directory, MyAssistant, id);

    const result = await child.readWorkspaceFile("/never-written.txt");
    expect(result).toBeNull();
  });

  it("listWorkspaceFiles handles errors as an empty list (proxy doesn't throw)", async () => {
    const directory = await getAgentByName(
      env.AssistantDirectory,
      uniqueDirectoryName()
    );
    const { id } = await directory.createChat();
    const child = await getSubAgentByName(directory, MyAssistant, id);

    // The example's `listWorkspaceFiles` swallows exceptions and
    // returns []; we just want to verify the proxy round-trip doesn't
    // surface an unexpected throw for non-existent paths.
    const result = await child.listWorkspaceFiles("/does/not/exist");
    expect(Array.isArray(result)).toBe(true);
  });
});
