import { describe, expect, it } from "vitest";
import { fetchExtension } from "../harness/extensions/fetch";
import {
  workspaceExtension,
  type ThinkExtension
} from "../harness/extensions/workspace";
import type { ThinkWorkspace } from "../workspace-files";

/** The tools an extension offers, by name, with their `recovery` field. */
async function recoveryOf(
  extension: ThinkExtension
): Promise<Record<string, unknown>> {
  const changes: ((tools: Map<string, object>) => unknown)[] = [];
  const ctx = {
    tools: {
      transform: (change: (tools: Map<string, object>) => unknown) =>
        changes.push(change)
    },
    prompt: { transform: () => {} }
  };
  await (extension as unknown as (c: typeof ctx) => unknown)(ctx);
  const tools = new Map<string, object>();
  for (const change of changes) await change(tools);
  return Object.fromEntries(
    [...tools].map(([name, tool]) => [
      name,
      (tool as { recovery?: unknown }).recovery
    ])
  );
}

describe("the shipped tools' recovery on the harness", () => {
  it("runs the workspace's reads again after an interruption, and reports its writes", async () => {
    const recovery = await recoveryOf(
      workspaceExtension(() => ({}) as ThinkWorkspace)
    );
    expect(recovery).toMatchObject({
      read: "rerun",
      ls: "rerun",
      grep: "rerun",
      find: "rerun",
      write: undefined,
      edit: undefined,
      delete: undefined
    });
  });

  it("runs a public fetch again, and reports a binding's", async () => {
    const recovery = await recoveryOf(
      fetchExtension(
        () => ({
          allowlist: ["example.com"],
          bindings: {
            api: {
              binding: { fetch } as unknown as Fetcher,
              allowlist: ["/v1/**"]
            }
          }
        }),
        () => ({}) as ThinkWorkspace,
        () => {}
      )
    );
    expect(recovery.fetch_url).toBe("rerun");
    const others = Object.entries(recovery).filter(([n]) => n !== "fetch_url");
    expect(others.length).toBeGreaterThan(0);
    for (const [, value] of others) expect(value).toBeUndefined();
  });
});
