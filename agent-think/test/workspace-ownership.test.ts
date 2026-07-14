import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { ThinkAgent } from "../src/index";

function tables(state: DurableObjectState): string[] {
  return [
    ...state.storage.sql.exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    )
  ].map(({ name }) => name);
}

describe("Workspace Durable Object ownership", () => {
  it("stores Workspace VFS tables only in the same-named Workspace object", async () => {
    const session = `workspace-owner-${crypto.randomUUID()}`;
    const think = await getAgentByName<Env, ThinkAgent>(
      env.ThinkAgent,
      session
    );
    await think.getContext();

    const workspaceObject = env.WorkspaceAgent.get(
      env.WorkspaceAgent.idFromName(session)
    );
    const workspace = await workspaceObject.getWorkspace();
    await workspace.fs.mkdir("/workspace", { recursive: true });
    await workspace.fs.writeFile("/workspace/owned.txt", "workspace-owned");

    const [thinkTables, workspaceTables, identity] = await Promise.all([
      runInDurableObject(think, (_instance, state) => tables(state)),
      runInDurableObject(workspaceObject, (_instance, state) => tables(state)),
      think.debugWorkspaceIdentity()
    ]);

    expect(identity.id).toBe(env.WorkspaceAgent.idFromName(session).toString());
    expect(await workspace.fs.readFile("/workspace/owned.txt", "utf8")).toBe(
      "workspace-owned"
    );
    expect(workspaceTables).toContain("_vfs_fetch_cursor");
    expect(thinkTables).not.toContain("_vfs_fetch_cursor");
    workspace[Symbol.dispose]();
  });

  it("keeps pending Workspace sync retry state and alarms out of Think storage", async () => {
    const session = `workspace-retry-owner-${crypto.randomUUID()}`;
    const think = await getAgentByName<Env, ThinkAgent>(
      env.ThinkAgent,
      session
    );
    await think.getContext();
    const workspaceObject = env.WorkspaceAgent.get(
      env.WorkspaceAgent.idFromName(session)
    );

    await workspaceObject.debugScheduleSyncRetryForTest({
      backend: "container",
      attempt: 1,
      notBefore: Date.now() + 60_000
    });

    const [thinkKeys, workspacePending, thinkAlarm, workspaceAlarm] =
      await Promise.all([
        runInDurableObject(think, async (_instance, state) => [
          ...(
            await state.storage.list({ prefix: "workspace:sync-retry:" })
          ).keys()
        ]),
        workspaceObject.debugPendingSyncRetryForTest("container"),
        runInDurableObject(think, (_instance, state) =>
          state.storage.getAlarm()
        ),
        runInDurableObject(workspaceObject, (_instance, state) =>
          state.storage.getAlarm()
        )
      ]);

    expect(thinkKeys).toEqual([]);
    expect(workspacePending).toMatchObject({
      backend: "container",
      attempt: 1
    });
    expect(thinkAlarm).toBeNull();
    expect(workspaceAlarm).not.toBeNull();
  });

  it("resetting Workspace storage cannot delete Think storage", async () => {
    const session = `workspace-reset-${crypto.randomUUID()}`;
    const think = await getAgentByName<Env, ThinkAgent>(
      env.ThinkAgent,
      session
    );
    await runInDurableObject(think, async (_instance, state) => {
      await state.storage.put("think-sentinel", "still-readable");
    });

    const workspaceObject = env.WorkspaceAgent.get(
      env.WorkspaceAgent.idFromName(session)
    );
    await workspaceObject.resetWorkspace();

    await expect(
      runInDurableObject(think, (_instance, state) =>
        state.storage.get("think-sentinel")
      )
    ).resolves.toBe("still-readable");
  });
});
