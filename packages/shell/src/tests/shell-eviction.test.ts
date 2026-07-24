/**
 * Forced Durable Object eviction coverage for Workspace.
 *
 * The helper tears down a running test actor while retaining its SQLite data.
 * These tests verify instance-state reset and filesystem reconstruction. They
 * do not assert natural idle hibernation or hibernation eligibility.
 */
import { env } from "cloudflare:workers";
import { evictAllDurableObjects, evictDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

function uniqueName(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function workspaceAgent(name: string) {
  return getAgentByName(env.TestWorkspaceAgent, name);
}

async function evictAndReacquire(
  name: string,
  stub: Awaited<ReturnType<typeof workspaceAgent>>
) {
  await evictDurableObject(stub as unknown as DurableObjectStub);
  return workspaceAgent(name);
}

describe("Workspace recovery after forced Durable Object eviction", () => {
  it("resets instance state and reconstructs the filesystem from SQLite", async () => {
    const name = uniqueName("evict-workspace");
    let agent = await workspaceAgent(name);

    await agent.mkdirCall("/project/src", { recursive: true });
    await agent.write("/project/src/index.ts", "export const x = 1;\n");
    await agent.write("/project/README.md", "# hello\n");
    await agent.writeBytes("/project/logo.bin", [0, 1, 2, 255, 128]);
    await agent.writeWithEvents("/event-source.txt", "event");
    expect((await agent.getChangeLog()) as unknown[]).not.toHaveLength(0);

    agent = await evictAndReacquire(name, agent);

    // changeLog is instance-only. The default Workspace rows are durable.
    expect(await agent.getChangeLog()).toEqual([]);
    expect(await agent.read("/project/src/index.ts")).toBe(
      "export const x = 1;\n"
    );
    expect(await agent.read("/project/README.md")).toBe("# hello\n");
    expect(await agent.readBytes("/project/logo.bin")).toEqual([
      0, 1, 2, 255, 128
    ]);

    // Writing on the fresh instance exercises idempotent schema initialization.
    await agent.write("/project/after.txt", "after");
    const info = (await agent.info()) as unknown as {
      fileCount: number;
      directoryCount: number;
    };
    expect(info).toMatchObject({ fileCount: 4, directoryCount: 3 });

    const listing = (await agent.list("/project")) as unknown as Array<{
      name: string;
    }>;
    expect(listing.map((entry) => entry.name).sort()).toEqual([
      "README.md",
      "after.txt",
      "logo.bin",
      "src"
    ]);
  });

  it("keeps named filesystems isolated after a global forced eviction", async () => {
    const nameA = uniqueName("evict-workspace-a");
    const nameB = uniqueName("evict-workspace-b");
    let agentA = await workspaceAgent(nameA);
    let agentB = await workspaceAgent(nameB);

    await agentA.write("/shared.txt", "A");
    await agentB.write("/shared.txt", "B");
    await agentA.write("/only-a.txt", "A-only");
    await agentB.write("/only-b.txt", "B-only");

    await evictAllDurableObjects();

    agentA = await workspaceAgent(nameA);
    agentB = await workspaceAgent(nameB);
    expect(await agentA.read("/shared.txt")).toBe("A");
    expect(await agentB.read("/shared.txt")).toBe("B");
    expect(await agentA.read("/only-b.txt")).toBeNull();
    expect(await agentB.read("/only-a.txt")).toBeNull();
  });
});
