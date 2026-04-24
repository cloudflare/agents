/**
 * `useChats()` — a local prototype hook on top of the sub-agent routing
 * primitive. NOT a library export.
 *
 * Wraps the `useAgent` connection to a user's `AssistantDirectory` and
 * exposes a small surface for sidebar behavior:
 *
 * ```tsx
 * const { directory, chats, createChat, deleteChat, renameChat } = useChats();
 * ```
 *
 * Why it lives in the example, not the library: the shape of `Chats` /
 * `useChats` is still in flux (what should the parent class own? how do
 * we handle permissions and cross-chat shared state?). Prototyping here
 * keeps us free to iterate — we'll promote it into a library API once
 * we're sure about the surface. See `wip/think-multi-session-assistant-plan.md`
 * (PR 4) for the long-term plan.
 */

import { useCallback } from "react";
import { useAgent } from "agents/react";
import type { ChatSummary, DirectoryState } from "./server";

export interface UseChats {
  /** Live `useAgent` handle for the parent directory. */
  directory: ReturnType<typeof useAgent<DirectoryState>>;
  /** Ordered chat list, most-recently-active first. */
  chats: ChatSummary[];
  /** Create a new chat and return it. */
  createChat: (opts?: { title?: string }) => Promise<ChatSummary>;
  /** Rename a chat. No-op if the new title is empty. */
  renameChat: (id: string, title: string) => Promise<void>;
  /** Delete a chat (idempotent — safe to call for an already-gone id). */
  deleteChat: (id: string) => Promise<void>;
}

export function useChats(): UseChats {
  const directory = useAgent<DirectoryState>({
    agent: "AssistantDirectory",
    basePath: "chat"
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

  return { directory, chats, createChat, renameChat, deleteChat };
}
