import { describe, expect, it } from "vitest";
import type { BackendHandle, WorkspaceBackend } from "@cloudflare/workspace";
import {
  ContainerLocalBackend,
  repoDirectory
} from "../src/container-workspace";

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
});
