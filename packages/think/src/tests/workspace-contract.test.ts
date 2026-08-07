import type { Workspace, WorkspaceClient } from "@cloudflare/computer";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  hasWorkspaceLegacyBashProvider,
  workspaceLegacyBashProvider,
  workspaceToolProvider,
  type ThinkWorkspace,
  type WorkspaceLegacyBashProvider,
  type WorkspaceToolProvider
} from "../workspace";

describe("ThinkWorkspace", () => {
  it("accepts local and client Computer workspaces", () => {
    expectTypeOf<Workspace>().toMatchTypeOf<ThinkWorkspace>();
    expectTypeOf<WorkspaceClient>().toMatchTypeOf<ThinkWorkspace>();
  });

  it("brands legacy Bash providers explicitly", () => {
    const backendFree = {
      fs: {},
      runtime: {}
    } as unknown as ThinkWorkspace;
    const legacy = {
      ...backendFree,
      [workspaceLegacyBashProvider]: true
    } as ThinkWorkspace & WorkspaceLegacyBashProvider;

    expect(hasWorkspaceLegacyBashProvider(backendFree)).toBe(false);
    expect(hasWorkspaceLegacyBashProvider(legacy)).toBe(true);
    expect(workspaceLegacyBashProvider).toBe(
      Symbol.for("@cloudflare/think/workspace-legacy-bash-provider")
    );
  });

  it("uses a stable symbol for opt-in workspace tools", () => {
    const provider: WorkspaceToolProvider = {
      [workspaceToolProvider]() {
        return {};
      }
    };

    expect(provider[workspaceToolProvider]()).toEqual({});
    expect(workspaceToolProvider).toBe(
      Symbol.for("@cloudflare/think/workspace-tool-provider")
    );
  });
});
