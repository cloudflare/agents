/**
 * Workspace broadcast tests.
 *
 * `AssistantDirectory.workspace` is constructed with
 * `onChange: (event) => this._broadcastWorkspaceChange(event)`, which
 * fans every workspace mutation out to every WebSocket client of the
 * directory as a `{ type: "workspace-change", event }` JSON frame.
 *
 * On the client side `useChats()` keys a `workspaceRevision` counter
 * off these frames; the file-browser pane's `useEffect` re-pulls
 * listings whenever the revision bumps. The frame shape is the
 * substrate that makes the live cross-chat/cross-tab UI work, so
 * we pin it down here.
 *
 * We connect a WS to the directory, write a file via direct RPC, and
 * assert the broadcast reaches the connected client.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import { connectWS, uniqueDirectoryName, waitForMatching } from "./helpers";

interface WorkspaceChangeFrame {
  type: "workspace-change";
  event: {
    type: "create" | "update" | "delete";
    path: string;
    [key: string]: unknown;
  };
}

function isWorkspaceChange(msg: unknown): msg is WorkspaceChangeFrame {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { type?: unknown }).type === "workspace-change"
  );
}

describe("workspace broadcast", () => {
  it("writeFile fires a workspace-change frame to directory clients", async () => {
    const directoryName = uniqueDirectoryName();
    // Prime the directory so onStart has fired and the workspace is
    // initialized before we connect. listSubAgents is a cheap RPC
    // that triggers wake without a state read.
    const directory = await getAgentByName(
      env.AssistantDirectory,
      directoryName
    );
    await directory.listSubAgents();

    const { ws } = await connectWS(
      `/agents/assistant-directory/${directoryName}`
    );

    try {
      // Trigger the mutation. The frame should arrive on `ws`.
      const writePromise = directory.writeFile(
        "/live.txt",
        "broadcast me",
        "text/plain"
      );

      const frame = await waitForMatching<unknown>(ws, isWorkspaceChange, 3000);
      // Drain the directory write before we close the socket so the DO
      // doesn't see a teardown mid-RPC.
      await writePromise;

      expect(isWorkspaceChange(frame)).toBe(true);
      const change = frame as WorkspaceChangeFrame;
      expect(change.event.path).toBe("/live.txt");
      expect(
        change.event.type === "create" || change.event.type === "update"
      ).toBe(true);
    } finally {
      ws.close();
    }
  });

  it("rm fires a workspace-change frame too", async () => {
    const directoryName = uniqueDirectoryName();
    const directory = await getAgentByName(
      env.AssistantDirectory,
      directoryName
    );
    await directory.writeFile("/temp.txt", "to be removed");

    const { ws } = await connectWS(
      `/agents/assistant-directory/${directoryName}`
    );

    try {
      const rmPromise = directory.rm("/temp.txt");

      const frame = await waitForMatching<unknown>(ws, isWorkspaceChange, 3000);
      await rmPromise;

      const change = frame as WorkspaceChangeFrame;
      expect(change.event.path).toBe("/temp.txt");
      expect(change.event.type).toBe("delete");
    } finally {
      ws.close();
    }
  });
});
