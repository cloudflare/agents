import { describe, expect, it } from "vitest";
import { repoDirectory, WORKSPACE_PULL_IGNORE } from "../src/workspace-policy";

describe("workspace policy", () => {
  it("keeps dependency, build, and scratch paths on the execution backend", () => {
    expect(WORKSPACE_PULL_IGNORE).toEqual([
      "node_modules",
      ".pnpm-store",
      "dist",
      "build",
      "temp"
    ]);
  });

  it("uses the repository name directly under /workspace", () => {
    expect(repoDirectory("cloudflare/agents")).toBe("/workspace/agents");
    expect(repoDirectory("owner/my repo")).toBe("/workspace/my-repo");
  });
});
