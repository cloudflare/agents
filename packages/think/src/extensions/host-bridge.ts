/**
 * HostBridgeLoopback — a WorkerEntrypoint that provides controlled workspace
 * access to extension Workers loaded via WorkerLoader.
 *
 * This is a loopback: the extension worker's `env.host` binding points here,
 * and each method call resolves the parent agent via `ctx.exports`, then
 * delegates to the agent's workspace proxy methods (`_hostReadFile`, etc.).
 *
 * Props carry serializable identifiers (agent class name, agent ID, and
 * permissions) so the binding survives across requests and hibernation.
 *
 * Users must re-export this class from their worker entry point:
 *
 * ```typescript
 * export { HostBridgeLoopback } from "@cloudflare/think/extensions";
 * ```
 *
 * @experimental The API surface may change before stabilizing.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import type { ExtensionPermissions } from "./types";

export type HostBridgeLoopbackProps = {
  agentClassName: string;
  agentId: string;
  permissions: ExtensionPermissions;
  /** Namespaced context labels this extension declared (for "own" write validation). */
  ownContextLabels?: string[];
};

export class HostBridgeLoopback extends WorkerEntrypoint<
  Record<string, unknown>,
  HostBridgeLoopbackProps
> {
  private _permissions = this.ctx.props.permissions;

  private _getAgent() {
    const { agentClassName, agentId } = this.ctx.props;
    // @ts-expect-error — experimental: ctx.exports on WorkerEntrypoint
    const ns = this.ctx.exports[agentClassName] as DurableObjectNamespace;
    return ns.get(ns.idFromString(agentId));
  }

  // ── Permission checks ──────────────────────────────────────────

  #requireWorkspace(level: "read" | "read-write"): void {
    const ws = this._permissions.workspace ?? "none";
    if (ws === "none") {
      throw new Error("Extension error: no workspace permission declared");
    }
    if (level === "read-write" && ws !== "read-write") {
      throw new Error(
        "Extension error: workspace write permission required, but only read granted"
      );
    }
  }

  #requireContextRead(label: string): void {
    const ctx = this._permissions.context;
    if (!ctx?.read) {
      throw new Error("Extension error: no context read permission declared");
    }
    if (ctx.read !== "all" && !ctx.read.includes(label)) {
      throw new Error(
        `Extension error: no read permission for context label "${label}"`
      );
    }
  }

  #requireContextWrite(label: string): void {
    const ctx = this._permissions.context;
    if (!ctx?.write) {
      throw new Error("Extension error: no context write permission declared");
    }
    if (ctx.write === "own") {
      const owned = this.ctx.props.ownContextLabels ?? [];
      if (!owned.includes(label)) {
        throw new Error(
          `Extension error: label "${label}" is not owned by this extension`
        );
      }
    } else if (!ctx.write.includes(label)) {
      throw new Error(
        `Extension error: no write permission for context label "${label}"`
      );
    }
  }

  #requireMessages(): void {
    if (this._permissions.messages !== "read") {
      throw new Error("Extension error: no messages read permission declared");
    }
  }

  #requireSendMessage(): void {
    if (!this._permissions.session?.sendMessage) {
      throw new Error(
        "Extension error: no session.sendMessage permission declared"
      );
    }
  }

  #requireSessionMetadata(): void {
    if (!this._permissions.session?.metadata) {
      throw new Error(
        "Extension error: no session.metadata permission declared"
      );
    }
  }

  // ── Workspace (existing) ───────────────────────────────────────

  async readFile(path: string): Promise<string | null> {
    this.#requireWorkspace("read");
    return (
      this._getAgent() as unknown as {
        _hostReadFile(path: string): Promise<string | null>;
      }
    )._hostReadFile(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.#requireWorkspace("read-write");
    return (
      this._getAgent() as unknown as {
        _hostWriteFile(path: string, content: string): Promise<void>;
      }
    )._hostWriteFile(path, content);
  }

  async deleteFile(path: string): Promise<boolean> {
    this.#requireWorkspace("read-write");
    return (
      this._getAgent() as unknown as {
        _hostDeleteFile(path: string): Promise<boolean>;
      }
    )._hostDeleteFile(path);
  }

  async listFiles(
    dir: string
  ): Promise<
    Array<{ name: string; type: string; size: number; path: string }>
  > {
    this.#requireWorkspace("read");
    return (
      this._getAgent() as unknown as {
        _hostListFiles(
          dir: string
        ): Promise<
          Array<{ name: string; type: string; size: number; path: string }>
        >;
      }
    )._hostListFiles(dir);
  }

  // ── Context blocks (new) ───────────────────────────────────────

  async getContext(label: string): Promise<string | null> {
    this.#requireContextRead(label);
    return (
      this._getAgent() as unknown as {
        _hostGetContext(label: string): Promise<string | null>;
      }
    )._hostGetContext(label);
  }

  async setContext(label: string, content: string): Promise<void> {
    this.#requireContextWrite(label);
    return (
      this._getAgent() as unknown as {
        _hostSetContext(label: string, content: string): Promise<void>;
      }
    )._hostSetContext(label, content);
  }

  // ── Messages (new) ────────────────────────────────────────────

  async getMessages(
    limit?: number
  ): Promise<Array<{ id: string; role: string; content: string }>> {
    this.#requireMessages();
    return (
      this._getAgent() as unknown as {
        _hostGetMessages(
          limit?: number
        ): Promise<Array<{ id: string; role: string; content: string }>>;
      }
    )._hostGetMessages(limit);
  }

  async sendMessage(content: string): Promise<void> {
    this.#requireSendMessage();
    return (
      this._getAgent() as unknown as {
        _hostSendMessage(content: string): Promise<void>;
      }
    )._hostSendMessage(content);
  }

  // ── Session metadata (new) ────────────────────────────────────

  async getSessionInfo(): Promise<{ messageCount: number }> {
    this.#requireSessionMetadata();
    return (
      this._getAgent() as unknown as {
        _hostGetSessionInfo(): Promise<{ messageCount: number }>;
      }
    )._hostGetSessionInfo();
  }
}
