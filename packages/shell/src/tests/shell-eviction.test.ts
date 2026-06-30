import { env } from "cloudflare:workers";
import { evictAllDurableObjects, evictDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { FileInfo, FileStat } from "../filesystem";

/**
 * Production-lifecycle eviction coverage for the shell `Workspace`, using the
 * real `evictDurableObject` / `evictAllDurableObjects` helpers (vitest-pool-
 * workers >= 0.16.20).
 *
 * The shell filesystem keeps its durable state in SQLite (the `cf_workspace_*`
 * tables, seeded lazily by `ensureInit()` via `CREATE TABLE IF NOT EXISTS`),
 * and a small slice of IN-MEMORY state on the live `Workspace`/agent instance:
 *   - `Workspace.initialized` — a per-instance "schema is ready" cache flag that
 *     short-circuits `ensureInit()` after the first call.
 *   - `TestWorkspaceAgent.changeLog` — a plain instance array populated by the
 *     `onChange` listener of the `wsWithEvents` workspace.
 *
 * Each test drives a DO until it has built up BOTH durable (SQLite) and
 * in-memory state, evicts it from memory (dropping the instance — and with it
 * `initialized` and `changeLog` — while preserving SQLite), then re-routes a
 * fresh stub for the SAME name and asserts the filesystem rebuilt itself from
 * storage with no loss, no duplication, and no schema corruption.
 *
 * Why the assertions are load-bearing (not vacuous "still works" smoke tests):
 * `changeLog` is a plain in-memory field that is NEVER persisted. After a real
 * eviction the rebuilt instance MUST observe an empty `changeLog`. If
 * `evictDurableObject` were a no-op (instance never torn down), the
 * pre-eviction events would still be in memory and the `toHaveLength(0)`
 * assertions below would FAIL. That same teardown resets `Workspace.initialized`
 * to `false`, forcing `ensureInit()` to re-run on the next access — which is
 * exactly the idempotent `CREATE TABLE IF NOT EXISTS` / root-seed path we assert
 * does not wipe or duplicate the stored rows.
 *
 * Re-acquiring after eviction mirrors a real post-hibernation request: the
 * runtime tore the instance down, and the next routed RPC (`getAgentByName`)
 * re-establishes a fresh agent that must rebuild from storage.
 */

function uniqueName(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function workspaceAgent(name: string) {
  return getAgentByName(env.TestWorkspaceAgent, name);
}

/**
 * Evict the DO from memory, then return a freshly-routed stub for the same
 * name. Mirrors a real post-hibernation request: the in-memory instance (and
 * its `Workspace.initialized` flag + `changeLog`) is gone; only SQLite survives.
 */
async function evictAndReacquire<T>(
  stub: T,
  reacquire: () => Promise<T>
): Promise<T> {
  await evictDurableObject(stub as unknown as DurableObjectStub);
  return reacquire();
}

describe("shell Workspace eviction — filesystem rehydrates from SQLite", () => {
  it("files and directories survive eviction with byte-exact content", async () => {
    const name = uniqueName("evict-fs");
    let agent = await workspaceAgent(name);

    // Build real, durable filesystem state in SQLite: nested dirs + files.
    await agent.mkdirCall("/project/src", { recursive: true });
    await agent.write("/project/src/index.ts", "export const x = 1;\n");
    await agent.write("/project/README.md", "# hello\n");
    await agent.writeBytes("/project/logo.bin", [0, 1, 2, 255, 128]);

    // Sanity: live instance sees the state pre-eviction.
    const beforeStat = (await agent.stat(
      "/project/src/index.ts"
    )) as unknown as FileStat;
    expect(beforeStat.type).toBe("file");

    // Production idle-eviction lifecycle: the in-memory instance (and its
    // `Workspace.initialized` cache flag) is torn down; only SQLite survives.
    agent = await evictAndReacquire(agent, () => workspaceAgent(name));

    // The rebuilt instance must read the SAME content back out of SQLite. If the
    // schema or rows did not survive, these reads would be null / throw.
    expect(await agent.read("/project/src/index.ts")).toBe(
      "export const x = 1;\n"
    );
    expect(await agent.read("/project/README.md")).toBe("# hello\n");
    expect(await agent.readBytes("/project/logo.bin")).toEqual([
      0, 1, 2, 255, 128
    ]);

    // Directory structure (parent rows) survived too — not just leaf files.
    const dirStat = (await agent.stat("/project/src")) as unknown as FileStat;
    expect(dirStat).not.toBeNull();
    expect(dirStat.type).toBe("directory");

    const listing = (await agent.list("/project")) as unknown as FileInfo[];
    const names = listing.map((i) => i.name).sort();
    expect(names).toEqual(["README.md", "logo.bin", "src"]);
  });

  it("the in-memory changeLog resets on eviction while SQLite rows persist", async () => {
    // This is the proof that the eviction is REAL and not a no-op: `changeLog`
    // is a plain instance array, never persisted. A genuine teardown must reset
    // it to empty; durable file rows must NOT reset.
    const name = uniqueName("evict-changelog");
    let agent = await workspaceAgent(name);

    // Two slices of state, both built BEFORE eviction:
    //  - `write` persists a file in the default-namespace table (durable SQLite).
    //  - `writeWithEvents` writes through `wsWithEvents` (the "evts" namespace),
    //    whose onChange pushes a create event onto the in-memory `changeLog`.
    await agent.write("/tracked.txt", "v1");
    await agent.writeWithEvents("/event-source.txt", "e1");
    const beforeLog = (await agent.getChangeLog()) as unknown as unknown[];
    expect(beforeLog.length).toBeGreaterThan(0);

    agent = await evictAndReacquire(agent, () => workspaceAgent(name));

    // LOAD-BEARING: the rebuilt instance's in-memory changeLog is empty. If the
    // DO were not actually evicted, the create event from before would still be
    // present and this would be non-empty — the test would fail. This is the
    // proof that the in-memory instance (and `Workspace.initialized`) was torn
    // down, not merely re-handed-back.
    const afterLog = (await agent.getChangeLog()) as unknown as unknown[];
    expect(afterLog).toHaveLength(0);

    // ...yet the durably-persisted file is still readable from SQLite after the
    // instance was rebuilt from storage.
    expect(await agent.read("/tracked.txt")).toBe("v1");
  });

  it("re-init after eviction is idempotent: no row loss, no schema duplication", async () => {
    const name = uniqueName("evict-idempotent");
    let agent = await workspaceAgent(name);

    // Seed a known, countable filesystem footprint.
    await agent.write("/a.txt", "aaa"); // 3 bytes
    await agent.write("/b.txt", "bb"); // 2 bytes
    await agent.mkdirCall("/dir");

    const before = (await agent.info()) as unknown as {
      fileCount: number;
      directoryCount: number;
      totalBytes: number;
    };
    expect(before.fileCount).toBe(2);
    // root ("/") + "/dir"
    expect(before.directoryCount).toBe(2);
    expect(before.totalBytes).toBe(5);

    // Evict: `Workspace.initialized` resets to false. The next operation forces
    // `ensureInit()` to re-run its `CREATE TABLE IF NOT EXISTS` + root-seed path.
    agent = await evictAndReacquire(agent, () => workspaceAgent(name));

    // Writing a NEW file after the wake triggers ensureInit() on the rebuilt
    // instance. A buggy re-init that re-created the table or re-seeded a second
    // root would corrupt the counts below.
    await agent.write("/c.txt", "cccc"); // 4 bytes

    const after = (await agent.info()) as unknown as {
      fileCount: number;
      directoryCount: number;
      totalBytes: number;
    };
    // Exactly the pre-eviction rows + the one new file. If CREATE TABLE were not
    // idempotent (or the root were double-seeded), these exact counts break.
    expect(after.fileCount).toBe(3);
    expect(after.directoryCount).toBe(2);
    expect(after.totalBytes).toBe(9);

    // Pre-eviction content is unchanged, and the new file reads back correctly.
    expect(await agent.read("/a.txt")).toBe("aaa");
    expect(await agent.read("/b.txt")).toBe("bb");
    expect(await agent.read("/c.txt")).toBe("cccc");
  });

  it("survives a CHAIN of evictions without corrupting or duplicating state", async () => {
    const name = uniqueName("evict-chain");
    let agent = await workspaceAgent(name);

    await agent.write("/log.txt", "line-1\n");

    // First eviction round-trip.
    agent = await evictAndReacquire(agent, () => workspaceAgent(name));
    expect(await agent.read("/log.txt")).toBe("line-1\n");
    await agent.write("/log.txt", "line-1\nline-2\n");

    // Second eviction must not lose the now-longer content nor duplicate rows.
    agent = await evictAndReacquire(agent, () => workspaceAgent(name));
    expect(await agent.read("/log.txt")).toBe("line-1\nline-2\n");

    const info = (await agent.info()) as unknown as {
      fileCount: number;
      directoryCount: number;
    };
    // One file, one (root) directory — no eviction-driven duplication.
    expect(info.fileCount).toBe(1);
    expect(info.directoryCount).toBe(1);
  });
});

describe("shell Workspace eviction — per-DO isolation under evictAllDurableObjects", () => {
  it("two named instances keep their own distinct filesystem after a global evict", async () => {
    const nameA = uniqueName("evict-iso-a");
    const nameB = uniqueName("evict-iso-b");

    let agentA = await workspaceAgent(nameA);
    let agentB = await workspaceAgent(nameB);

    // Each DO owns its own SQLite, so identical paths must hold distinct content.
    await agentA.write("/shared-path.txt", "owned-by-A");
    await agentB.write("/shared-path.txt", "owned-by-B");
    // Give each a unique extra file so cross-contamination would be detectable.
    await agentA.write("/only-a.txt", "A-only");
    await agentB.write("/only-b.txt", "B-only");

    // Evict EVERY running DO at once (production-style fleet idle eviction).
    await evictAllDurableObjects();

    // Re-route both. Each rebuilds from its OWN storage.
    agentA = await workspaceAgent(nameA);
    agentB = await workspaceAgent(nameB);

    // Same path, different content — proves the per-DO SQLite boundary held
    // across a global eviction (no leaking/merging of rehydrated state).
    expect(await agentA.read("/shared-path.txt")).toBe("owned-by-A");
    expect(await agentB.read("/shared-path.txt")).toBe("owned-by-B");

    // Each instance's unique file exists only in its own filesystem.
    expect(await agentA.read("/only-a.txt")).toBe("A-only");
    expect(await agentA.read("/only-b.txt")).toBeNull();
    expect(await agentB.read("/only-b.txt")).toBe("B-only");
    expect(await agentB.read("/only-a.txt")).toBeNull();
  });
});
