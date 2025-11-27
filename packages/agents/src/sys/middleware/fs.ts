export type FSEntry = {
  type: "file" | "dir";
  /** Path relative to the agent's view (e.g., "foo.txt" or "/shared/config.json") */
  path: string;
  size?: number;
  ts?: Date;
  owner?: string;
};

export type AgentFSContext = {
  agencyId: string;
  agentId: string;
};

/**
 * Path layout in R2:
 *   /{agencyId}/shared/...           - Shared files across all agents in an agency
 *   /{agencyId}/agents/{agentId}/... - Per-agent home directory
 *
 * Path resolution rules:
 *   - Relative paths (no leading /) resolve to agent's home
 *   - "/shared/..." resolves to agency shared space
 *   - "/agents/{id}/..." resolves to another agent's home (if permissions allow)
 *   - "~" or "~/..." explicitly refers to own home
 */
export class AgentFileSystem {
  constructor(
    private bucket: R2Bucket,
    private ctx: AgentFSContext
  ) {}

  private get homePrefix(): string {
    return `${this.ctx.agencyId}/agents/${this.ctx.agentId}/`;
  }

  private get sharedPrefix(): string {
    return `${this.ctx.agencyId}/shared/`;
  }

  private get agencyPrefix(): string {
    return `${this.ctx.agencyId}/`;
  }

  /**
   * Resolve a user-facing path to an R2 key.
   * - Relative paths → agent home
   * - /shared/... → shared space
   * - /agents/{id}/... → other agent's home
   * - ~ or ~/... → own home (explicit)
   */
  resolvePath(userPath: string): string {
    const p = userPath.trim();

    // Handle home shorthand
    if (p === "~" || p === "~/") return this.homePrefix;
    if (p.startsWith("~/")) return this.homePrefix + p.slice(2);

    // Absolute paths within agency
    if (p.startsWith("/")) {
      const withoutSlash = p.slice(1);
      // /shared/...
      if (withoutSlash === "shared" || withoutSlash.startsWith("shared/")) {
        return this.agencyPrefix + withoutSlash;
      }
      // /agents/{id}/...
      if (withoutSlash.startsWith("agents/")) {
        return this.agencyPrefix + withoutSlash;
      }
      // Other absolute paths resolve to home
      return this.homePrefix + withoutSlash;
    }

    // Relative path → home
    return this.homePrefix + p;
  }

  /**
   * Convert an R2 key back to user-facing path.
   * Strips agency prefix and presents paths relative to agent's view.
   */
  toUserPath(r2Key: string): string {
    // Strip agency prefix
    if (!r2Key.startsWith(this.agencyPrefix)) return r2Key;
    const agencyRelative = r2Key.slice(this.agencyPrefix.length);

    // If it's in our home, show as relative
    const homeRel = `agents/${this.ctx.agentId}/`;
    if (agencyRelative.startsWith(homeRel)) {
      const rel = agencyRelative.slice(homeRel.length);
      return rel || ".";
    }

    // Otherwise show as absolute within agency
    return "/" + agencyRelative;
  }

  private objToEntry(obj: R2Object): FSEntry {
    return {
      type: "file" as const,
      path: this.toUserPath(obj.key),
      size: obj.size,
      ts: obj.uploaded
    };
  }

  /**
   * Check if the agent has access to a given R2 key.
   * Currently: agents can read/write their home and shared space.
   * Reading other agents' homes is allowed (collaborative), writing is not.
   */
  checkAccess(
    r2Key: string,
    mode: "read" | "write"
  ): { allowed: boolean; reason?: string } {
    // Must be within our agency
    if (!r2Key.startsWith(this.agencyPrefix)) {
      return { allowed: false, reason: "Path outside agency" };
    }

    const rel = r2Key.slice(this.agencyPrefix.length);

    // Shared space: read/write allowed
    if (rel.startsWith("shared/") || rel === "shared") {
      return { allowed: true };
    }

    // Own home: read/write allowed
    const ownHome = `agents/${this.ctx.agentId}/`;
    if (rel.startsWith(ownHome) || rel === `agents/${this.ctx.agentId}`) {
      return { allowed: true };
    }

    // Other agent's home
    if (rel.startsWith("agents/")) {
      if (mode === "read") {
        return { allowed: true }; // Collaborative read
      }
      return { allowed: false, reason: "Cannot write to another agent's home" };
    }

    return { allowed: false, reason: "Invalid path" };
  }

  /**
   * List directory contents.
   * @param path User-facing path (e.g., ".", "/shared", "~/subdir")
   */
  async readDir(path = "."): Promise<FSEntry[]> {
    let r2Prefix = this.resolvePath(path);
    // Ensure trailing slash for directory listing
    if (!r2Prefix.endsWith("/")) r2Prefix += "/";

    const access = this.checkAccess(r2Prefix, "read");
    if (!access.allowed) {
      throw new Error(`Access denied: ${access.reason}`);
    }

    const list = await this.bucket.list({
      prefix: r2Prefix,
      delimiter: "/"
    });

    const entries: FSEntry[] = [
      ...list.objects.map((obj) => this.objToEntry(obj)),
      ...list.delimitedPrefixes.map((pref) => ({
        type: "dir" as const,
        path: this.toUserPath(pref)
      }))
    ];

    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }

  async delete(paths: string[]): Promise<void> {
    const r2Keys: string[] = [];
    for (const p of paths) {
      const key = this.resolvePath(p);
      const access = this.checkAccess(key, "write");
      if (!access.allowed) {
        throw new Error(`Cannot delete '${p}': ${access.reason}`);
      }
      r2Keys.push(key);
    }
    await this.bucket.delete(r2Keys);
  }

  async stat(path: string): Promise<FSEntry | null> {
    const r2Key = this.resolvePath(path);
    const access = this.checkAccess(r2Key, "read");
    if (!access.allowed) {
      throw new Error(`Access denied: ${access.reason}`);
    }

    const obj = await this.bucket.head(r2Key);
    if (!obj) return null;
    return this.objToEntry(obj);
  }

  async writeFile(
    path: string,
    data: string | ArrayBuffer | Uint8Array
  ): Promise<void> {
    const r2Key = this.resolvePath(path);
    const access = this.checkAccess(r2Key, "write");
    if (!access.allowed) {
      throw new Error(`Cannot write '${path}': ${access.reason}`);
    }
    await this.bucket.put(r2Key, data);
  }

  async readFile(path: string, stream: true): Promise<ReadableStream | null>;
  async readFile(path: string, stream?: false): Promise<string | null>;
  async readFile(
    path: string,
    stream = false
  ): Promise<ReadableStream | string | null> {
    const r2Key = this.resolvePath(path);
    const access = this.checkAccess(r2Key, "read");
    if (!access.allowed) {
      throw new Error(`Cannot read '${path}': ${access.reason}`);
    }

    const obj = await this.bucket.get(r2Key);
    if (!obj || !obj.body) return null;
    return stream ? obj.body : obj.text();
  }

  /**
   * Edit file with find-replace semantics.
   */
  async editFile(
    path: string,
    oldStr: string,
    newStr: string,
    replaceAll = false
  ): Promise<{ replaced: number; content: string }> {
    const current = await this.readFile(path, false);
    if (current === null) {
      return { replaced: 0, content: "" };
    }

    const count = (current.match(new RegExp(escapeRegExp(oldStr), "g")) || [])
      .length;
    if (count === 0) {
      return { replaced: 0, content: current };
    }
    if (!replaceAll && count > 1) {
      return { replaced: -count, content: current }; // Ambiguous
    }

    const content = replaceAll
      ? current.split(oldStr).join(newStr)
      : current.replace(oldStr, newStr);

    await this.writeFile(path, content);
    return { replaced: replaceAll ? count : 1, content };
  }

  /**
   * Check if a file exists.
   */
  async exists(path: string): Promise<boolean> {
    const entry = await this.stat(path);
    return entry !== null;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
