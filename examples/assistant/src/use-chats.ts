/**
 * `useChats()` — a local prototype hook on top of the sub-agent routing
 * primitive. NOT a library export.
 *
 * Wraps the `useAgent` connection to a user's `AssistantDirectory` and
 * exposes a small surface for sidebar behavior:
 *
 * ```tsx
 * const {
 *   directory,
 *   chats,
 *   workspaceRevision,
 *   createChat,
 *   deleteChat,
 *   renameChat
 * } = useChats();
 * ```
 *
 * `workspaceRevision` is a monotonically increasing counter the
 * directory bumps every time the shared workspace changes. Use it as a
 * `useEffect` dep to keep workspace-backed UI live across chats and
 * open tabs without polling.
 *
 * Why it lives in the example, not the library: the shape of `Chats` /
 * `useChats` is still in flux (what should the parent class own? how do
 * we handle permissions and cross-chat shared state?). Prototyping here
 * keeps us free to iterate — we'll promote it into a library API once
 * we're sure about the surface. See `wip/think-multi-session-assistant-plan.md`
 * (PR 4) for the long-term plan.
 */

import { useCallback, useState } from "react";
import { useAgent } from "agents/react";
import type { ChatSummary, DirectoryState } from "./server";

export interface UseChats {
  /** Live `useAgent` handle for the parent directory. */
  directory: ReturnType<typeof useAgent<DirectoryState>>;
  /** Ordered chat list, most-recently-active first. */
  chats: ChatSummary[];
  /**
   * Ticks up every time the shared workspace changes, regardless of
   * which chat caused the change. Consumers can pass this as a
   * `useEffect` dependency to refresh workspace-backed UI (file
   * browsers, tree views, etc.).
   */
  workspaceRevision: number;
  /** Create a new chat and return it. */
  createChat: (opts?: { title?: string }) => Promise<ChatSummary>;
  /** Rename a chat. No-op if the new title is empty. */
  renameChat: (id: string, title: string) => Promise<void>;
  /** Delete a chat (idempotent — safe to call for an already-gone id). */
  deleteChat: (id: string) => Promise<void>;
}

function isWorkspaceChangeMessage(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const msg = value as Record<string, unknown>;
  if (msg.type !== "workspace-change") return false;
  const event = msg.event;
  if (typeof event !== "object" || event === null) return false;
  const ev = event as Record<string, unknown>;
  return typeof ev.path === "string" && typeof ev.type === "string";
}

export function useChats(): UseChats {
  const [workspaceRevision, setWorkspaceRevision] = useState(0);

  const directory = useAgent<DirectoryState>({
    agent: "AssistantDirectory",
    basePath: "chat",
    // The directory broadcasts `{ type: "workspace-change", event }` on
    // every shared-workspace mutation (see AssistantDirectory.workspace's
    // onChange hook). `useAgent` passes through anything it doesn't
    // recognize internally, so we parse here and expose a revision
    // counter for downstream effects to key on.
    //
    // We intentionally don't expose the `event` payload itself here —
    // nothing in the example reads it yet, and routing it reactively
    // would need a state update rather than a ref. If a future consumer
    // needs per-event details, change this to a `useState<{ revision,
    // event }>` and expose both fields at once.
    onMessage: (message) => {
      if (typeof message.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.data);
      } catch {
        return;
      }
      if (isWorkspaceChangeMessage(parsed)) {
        setWorkspaceRevision((n) => n + 1);
      }
    }
  });

  const chats: ChatSummary[] = directory.state?.chats ?? [];

  const createChat = useCallback(
    async (opts?: { title?: string }) =>
      (await directory.call("createChat", opts ? [opts] : [])) as ChatSummary,
    [directory]
  );

  const renameChat = useCallback(
    async (id: string, title: string) => {
      await directory.call("renameChat", [id, title]);
    },
    [directory]
  );

  const deleteChat = useCallback(
    async (id: string) => {
      await directory.call("deleteChat", [id]);
    },
    [directory]
  );

  return {
    directory,
    chats,
    workspaceRevision,
    createChat,
    renameChat,
    deleteChat
  };
}
