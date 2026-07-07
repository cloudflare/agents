import { describe, expect, it } from "vitest";
import type { BackendHandle, WorkspaceBackend } from "@cloudflare/workspace";
import {
  ContainerLocalBackend,
  repoDirectory
} from "../src/container-workspace";
import { selectExpiredAssignments } from "../src/warm-pool";

describe("container-local workspace", () => {
  it("disables Workspace push/pull sync", async () => {
    const handle = {
      rpc: {},
      sync: "remote",
      close: async () => {}
    } as unknown as BackendHandle;
    const backend: WorkspaceBackend = {
      id: "container",
      type: "test",
      connect: async () => handle
    };

    expect(await new ContainerLocalBackend(backend).connect()).toBe(handle);
    expect(handle.sync).toBe("none");
  });

  it("uses the repository name directly under /workspace", () => {
    expect(repoDirectory("cloudflare/agents")).toBe("/workspace/agents");
    expect(repoDirectory("owner/my repo")).toBe("/workspace/my-repo");
  });

  it("does not evict an actively leased assignment", () => {
    const assignments = new Map([
      [
        "active",
        {
          uuid: "container-active",
          touchedAt: 0,
          activeLease: { id: "run-1", expiresAt: 20_000 }
        }
      ],
      ["idle", { uuid: "container-idle", touchedAt: 0 }]
    ]);

    expect(selectExpiredAssignments(assignments, 10_000, 1_000)).toEqual([
      { sandboxId: "idle", uuid: "container-idle", touchedAt: 0 }
    ]);
  });

  it("eventually evicts an abandoned expired lease", () => {
    const assignments = new Map([
      [
        "stale",
        {
          uuid: "container-stale",
          touchedAt: 0,
          activeLease: { id: "dead-run", expiresAt: 9_999 }
        }
      ]
    ]);

    expect(selectExpiredAssignments(assignments, 10_000, 1_000)).toEqual([
      { sandboxId: "stale", uuid: "container-stale", touchedAt: 0 }
    ]);
  });
});
