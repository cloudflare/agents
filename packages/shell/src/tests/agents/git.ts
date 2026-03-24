/**
 * Test agent for git operations — uses Workspace (DO SQLite) as the backing fs.
 */

import { Agent } from "agents";
import { Workspace } from "../../filesystem";
import { createGit, type Git } from "../../git/index";
import { WorkspaceFileSystem } from "../../workspace";

export class TestGitAgent extends Agent {
  workspace = new Workspace({
    sql: this.ctx.storage.sql,
    name: () => this.name
  });
  private _git: Git | null = null;

  private git(): Git {
    if (!this._git) {
      this._git = createGit(new WorkspaceFileSystem(this.workspace));
    }
    return this._git;
  }

  async init(opts?: { defaultBranch?: string }) {
    return this.git().init(opts);
  }

  async writeFile(path: string, content: string) {
    await this.workspace.writeFile(path, content);
  }

  async readFile(path: string) {
    return this.workspace.readFile(path);
  }

  async add(opts: { filepath: string }) {
    return this.git().add(opts);
  }

  async commit(opts: {
    message: string;
    author?: { name: string; email: string };
  }) {
    return this.git().commit(opts);
  }

  async status() {
    return this.git().status();
  }

  async log(opts?: { depth?: number; ref?: string }) {
    return this.git().log(opts);
  }

  async branch(opts?: { name?: string; list?: boolean; delete?: string }) {
    return this.git().branch(opts);
  }

  async checkout(opts: { ref?: string; branch?: string; force?: boolean }) {
    return this.git().checkout(opts);
  }

  async diff() {
    return this.git().diff();
  }

  async rm(opts: { filepath: string }) {
    return this.git().rm(opts);
  }

  async remote(opts: {
    list?: boolean;
    add?: { name: string; url: string };
    remove?: string;
  }) {
    return this.git().remote(opts);
  }

  async deleteFile(path: string) {
    return this.workspace.deleteFile(path);
  }

  async clone(opts: {
    url: string;
    depth?: number;
    branch?: string;
    token?: string;
  }) {
    return this.git().clone(opts);
  }
}
