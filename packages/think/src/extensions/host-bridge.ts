/**
 * HostBridge — an RpcTarget passed from the host to extension Workers.
 *
 * Provides controlled access to the host's workspace, gated by the
 * extension's declared permissions. Each tool call gets a fresh bridge
 * so permissions are enforced per-invocation.
 */

import { RpcTarget } from "cloudflare:workers";
import type { Workspace } from "agents/experimental/workspace";
import type { ExtensionPermissions } from "./types";

export class HostBridge extends RpcTarget {
  #workspace: Workspace | null;
  #permissions: ExtensionPermissions;

  constructor(workspace: Workspace | null, permissions: ExtensionPermissions) {
    super();
    this.#workspace = workspace;
    this.#permissions = permissions;
  }

  async readFile(path: string): Promise<string | null> {
    this.#requireWorkspace("read");
    return this.#workspace!.readFile(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.#requireWorkspace("read-write");
    await this.#workspace!.writeFile(path, content);
  }

  async deleteFile(path: string): Promise<boolean> {
    this.#requireWorkspace("read-write");
    return this.#workspace!.deleteFile(path);
  }

  listFiles(
    dir: string
  ): Array<{ name: string; type: string; size: number; path: string }> {
    this.#requireWorkspace("read");
    return this.#workspace!.readDir(dir);
  }

  #requireWorkspace(
    minLevel: "read" | "read-write"
  ): asserts this is { "#workspace": Workspace } {
    if (!this.#workspace) {
      throw new Error("Extension error: no workspace available on host");
    }
    const level = this.#permissions.workspace ?? "none";
    if (level === "none") {
      throw new Error("Extension error: no workspace permission declared");
    }
    if (minLevel === "read-write" && level !== "read-write") {
      throw new Error(
        "Extension error: workspace write permission required, but only read granted"
      );
    }
  }
}
