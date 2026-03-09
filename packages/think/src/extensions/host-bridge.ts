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
 * @experimental Requires the `"experimental"` compatibility flag.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import type { ExtensionPermissions } from "./types";

export type HostBridgeLoopbackProps = {
  agentClassName: string;
  agentId: string;
  permissions: ExtensionPermissions;
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

  #requirePermission(level: "read" | "read-write"): void {
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

  async readFile(path: string): Promise<string | null> {
    this.#requirePermission("read");
    return (
      this._getAgent() as unknown as {
        _hostReadFile(path: string): Promise<string | null>;
      }
    )._hostReadFile(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.#requirePermission("read-write");
    return (
      this._getAgent() as unknown as {
        _hostWriteFile(path: string, content: string): Promise<void>;
      }
    )._hostWriteFile(path, content);
  }

  async deleteFile(path: string): Promise<boolean> {
    this.#requirePermission("read-write");
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
    this.#requirePermission("read");
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
}
