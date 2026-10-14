import { describe, expect, it } from "vitest";
import type { ThinkWorkspace } from "../workspace-files";
import { lazyWorkspace } from "../workspace-files";

// A workspace whose stat answers with its own label, so a test can tell
// which resolved workspace served a call.
function workspace(label: string): ThinkWorkspace {
  // SAFETY: These tests only call `stat`, and only read `size` from it.
  return {
    fs: { stat: async () => ({ size: label.length, label }) }
  } as unknown as ThinkWorkspace;
}

describe("lazyWorkspace", () => {
  it("resolves on first use and keeps the result", async () => {
    let calls = 0;
    const lazy = lazyWorkspace(async () => {
      calls++;
      return workspace("first");
    });
    expect(calls).toBe(0);
    await lazy.fs.stat("/a");
    await lazy.fs.stat("/b");
    expect(calls).toBe(1);
  });

  it("tries again after a failed resolution", async () => {
    let calls = 0;
    const lazy = lazyWorkspace(async () => {
      calls++;
      if (calls === 1) throw new Error("owner unavailable");
      return workspace("second");
    });
    await expect(lazy.fs.stat("/a")).rejects.toThrow("owner unavailable");
    await expect(lazy.fs.stat("/a")).resolves.toMatchObject({ size: 6 });
    expect(calls).toBe(2);
  });
});
