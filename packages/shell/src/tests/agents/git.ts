/**
 * Test agent for git operations — uses Workspace (DO SQLite) as the backing fs.
 */

import { Agent, callable } from "agents";
import { Workspace } from "../../filesystem";
import { createGit, type Git } from "../../git/index";
import { WorkspaceFileSystem } from "../../workspace";

export class TestGitAgent extends Agent<Env> {
  workspace = new Workspace(this);
  private _git: Git | null = null;

  private git(): Git {
    if (!this._git) {
      this._git = createGit(new WorkspaceFileSystem(this.workspace));
    }
    return this._git;
  }

  @callable()
  async init(opts?: { defaultBranch?: string }) {
    return this.git().init(opts);
  }

  @callable()
  async writeFile(path: string, content: string) {
    await this.workspace.writeFile(path, content);
  }

  @callable()
  async readFile(path: string) {
    return this.workspace.readFile(path);
  }

  @callable()
  async add(opts: { filepath: string }) {
    return this.git().add(opts);
  }

  @callable()
  async commit(opts: { message: string; author?: { name: string; email: string } }) {
    return this.git().commit(opts);
  }

  @callable()
  async status() {
    return this.git().status();
  }

  @callable()
  async log(opts?: { depth?: number; ref?: string }) {
    return this.git().log(opts);
  }

  @callable()
  async branch(opts?: { name?: string; list?: boolean; delete?: string }) {
    return this.git().branch(opts);
  }

  @callable()
  async checkout(opts: { ref?: string; branch?: string; force?: boolean }) {
    return this.git().checkout(opts);
  }

  @callable()
  async diff() {
    return this.git().diff();
  }

  @callable()
  async clone(opts: { url: string; depth?: number; branch?: string; token?: string }) {
    return this.git().clone(opts);
  }
}
