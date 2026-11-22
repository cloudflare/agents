/**
 * What a sandboxed extension can reach on its Think agent through
 * `HostBridgeLoopback`. The loopback checks the extension's permissions
 * before it calls the agent; this module is the agent side.
 */

import type { UIMessage } from "ai";
import type { ContextBlocks } from "agents/context";
import { WorkspaceFiles, resolveWorkspacePath } from "../workspace-files";
import type { ThinkWorkspace } from "../workspace-files";

/** @internal */
export interface ThinkHostFileEntry {
  name: string;
  type: string;
  size: number;
  path: string;
}

/** @internal */
export interface ThinkHostMessage {
  id: string;
  role: string;
  content: string;
}

/**
 * The operations `HostBridgeLoopback` forwards to the agent.
 *
 * @internal
 */
export interface ThinkHostApi {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  /** `false` when the file could not be removed. */
  deleteFile(path: string): Promise<boolean>;
  listFiles(dir: string): Promise<ThinkHostFileEntry[]>;
  getContext(label: string): Promise<string | null>;
  setContext(label: string, content: string): Promise<void>;
  /** The last `limit` messages as plain text; all of them when omitted. */
  getMessages(limit?: number): Promise<ThinkHostMessage[]>;
  /** Append a user message, visible to the next turn. */
  sendMessage(content: string): Promise<void>;
  getSessionInfo(): Promise<{ messageCount: number }>;
}

/** @internal */
export type ThinkHostOperation = keyof ThinkHostApi;

/**
 * What {@link createThinkHostApi} reads from the agent.
 *
 * @internal
 */
export interface ThinkHostApiOptions {
  readonly workspace: () => ThinkWorkspace;
  readonly context: () => ContextBlocks;
  readonly messages: () => UIMessage[];
  /**
   * Append a message to the session directly. It must not start a turn: an
   * extension tool can call `sendMessage` during a turn, and waiting for the
   * turn queue there would deadlock.
   */
  readonly appendMessage: (message: UIMessage) => Promise<unknown>;
}

/** @internal */
export function createThinkHostApi(options: ThinkHostApiOptions): ThinkHostApi {
  const files = () => new WorkspaceFiles(options.workspace());
  return {
    readFile: (path) => files().readText(resolveWorkspacePath(path)),
    writeFile: (path, content) =>
      files().write(resolveWorkspacePath(path), content),
    async deleteFile(path) {
      try {
        await files().remove(resolveWorkspacePath(path));
        return true;
      } catch {
        return false;
      }
    },
    async listFiles(dir) {
      const entries = await files().list(resolveWorkspacePath(dir));
      return entries.map((e) => ({
        name: e.name,
        type: e.type,
        size: e.size,
        path: e.path
      }));
    },
    async getContext(label) {
      return options.context().getBlock(label)?.content ?? null;
    },
    async setContext(label, content) {
      await options.context().setBlock(label, content);
    },
    async getMessages(limit) {
      const history = options.messages();
      const sliced =
        limit !== undefined && limit !== null
          ? limit <= 0
            ? []
            : history.slice(-limit)
          : history;
      return sliced.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.parts
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("")
      }));
    },
    async sendMessage(content) {
      await options.appendMessage({
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: content }]
      });
    },
    async getSessionInfo() {
      return { messageCount: options.messages().length };
    }
  };
}

/**
 * Run one host operation by name. Rejects a name that is not an operation.
 *
 * @internal
 */
export function callThinkHostApi<K extends ThinkHostOperation>(
  api: ThinkHostApi,
  operation: K,
  args: Parameters<ThinkHostApi[K]>
): ReturnType<ThinkHostApi[K]> {
  if (!Object.prototype.hasOwnProperty.call(api, operation)) {
    throw new Error(`Unknown host operation: ${String(operation)}`);
  }
  const fn = api[operation] as (
    ...callArgs: Parameters<ThinkHostApi[K]>
  ) => ReturnType<ThinkHostApi[K]>;
  return fn(...args);
}
