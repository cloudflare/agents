/**
 * Workspace broadcast tests.
 *
 * After every turn a chat calls `AssistantDirectory.workspaceChanged()`,
 * which sends `{ type: "workspace-change" }` to every WebSocket client of
 * the directory. On the client side `useChats()` keys a
 * `workspaceRevision` counter off these frames, and the file-browser
 * pane re-pulls its listing whenever the revision bumps. We pin the frame
 * down here.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import { connectWS, uniqueDirectoryName, waitForMatching } from "./helpers";

function isWorkspaceChange(msg: unknown): boolean {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { type?: unknown }).type === "workspace-change"
  );
}

describe("workspace broadcast", () => {
  it("workspaceChanged sends a workspace-change frame to directory clients", async () => {
    const directoryName = uniqueDirectoryName();
    const directory = await getAgentByName(
      env.AssistantDirectory,
      directoryName
    );
    await directory.listSubAgents();

    const { ws } = await connectWS(
      `/agents/assistant-directory/${directoryName}`
    );

    try {
      const announce = directory.workspaceChanged();
      const frame = await waitForMatching<unknown>(ws, isWorkspaceChange, 3000);
      await announce;
      expect(frame).toEqual({ type: "workspace-change" });
    } finally {
      ws.close();
    }
  });
});
