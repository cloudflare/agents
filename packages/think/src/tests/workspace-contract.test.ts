import type { Workspace as ComputerWorkspace } from "@cloudflare/computer";
import { describe, expect, it } from "vitest";
import type { ThinkWorkspace } from "../workspace/types";
import { Workspace } from "../workspace/workspace";

function acceptsThinkWorkspace(_workspace: ThinkWorkspace): void {}

describe("Computer workspace entrypoint", () => {
  it("exports a Computer workspace that satisfies Think's contract", () => {
    const local: ComputerWorkspace = null as unknown as Workspace;
    acceptsThinkWorkspace(local);
    expect(Workspace).toBeDefined();
  });
});
