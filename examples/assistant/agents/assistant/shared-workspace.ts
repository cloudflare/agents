import type { Workspace } from "@cloudflare/think";
import type { WorkspaceFsLike } from "@cloudflare/shell";
import type { AssistantDirectory } from "./agent";

// ── SharedWorkspace — proxy used by children ─────────────────────────
//
// Satisfies `WorkspaceFsLike` (the interface shipped by
// `@cloudflare/shell`) by forwarding every call to the parent
// `AssistantDirectory`'s real `Workspace`. Because `WorkspaceFsLike`
// is a strict superset of `WorkspaceLike`, this also satisfies
// everything Think's builtin tools need — but covering the wider
// surface is what lets us pass the same object to
// `createWorkspaceStateBackend`, so codemode's `state.*` sandbox API
// operates on the shared workspace too.
//
// Per-call it's one extra RPC hop; parent and child are DO facets
// colocated on the same machine, so the hop is in-process and cheap.
//
// The parent stub is resolved lazily on first use and cached. Stubs
// from `parentAgent()` are thin proxies — they don't hold connections,
// so caching the resolved stub across the child's lifetime is safe
// even if the parent hibernates and comes back between calls.

export class SharedWorkspace implements WorkspaceFsLike {
  #stubPromise?: Promise<DurableObjectStub<AssistantDirectory>>;

  constructor(
    private getParent: () => Promise<DurableObjectStub<AssistantDirectory>>
  ) {}

  private parent(): Promise<DurableObjectStub<AssistantDirectory>> {
    this.#stubPromise ??= this.getParent();
    return this.#stubPromise;
  }

  async readFile(path: string) {
    return (await this.parent()).readFile(path);
  }

  async readFileBytes(path: string) {
    return (await this.parent()).readFileBytes(path);
  }

  async writeFile(
    path: string,
    content: string,
    mimeType?: Parameters<Workspace["writeFile"]>[2]
  ) {
    return (await this.parent()).writeFile(path, content, mimeType);
  }

  async writeFileBytes(
    path: string,
    content: Parameters<Workspace["writeFileBytes"]>[1],
    mimeType?: Parameters<Workspace["writeFileBytes"]>[2]
  ) {
    return (await this.parent()).writeFileBytes(path, content, mimeType);
  }

  async appendFile(
    path: string,
    content: string,
    mimeType?: Parameters<Workspace["appendFile"]>[2]
  ) {
    return (await this.parent()).appendFile(path, content, mimeType);
  }

  async exists(path: string) {
    return (await this.parent()).exists(path);
  }

  async readDir(path?: string, opts?: Parameters<Workspace["readDir"]>[1]) {
    return (await this.parent()).readDir(path ?? "/", opts);
  }

  async rm(path: string, opts?: Parameters<Workspace["rm"]>[1]) {
    return (await this.parent()).rm(path, opts);
  }

  async glob(pattern: string) {
    return (await this.parent()).glob(pattern);
  }

  async mkdir(path: string, opts?: Parameters<Workspace["mkdir"]>[1]) {
    return (await this.parent()).mkdir(path, opts);
  }

  async stat(path: string) {
    return (await this.parent()).stat(path);
  }

  async lstat(path: string) {
    return (await this.parent()).lstat(path);
  }

  async cp(src: string, dest: string, opts?: Parameters<Workspace["cp"]>[2]) {
    return (await this.parent()).cp(src, dest, opts);
  }

  async mv(src: string, dest: string) {
    return (await this.parent()).mv(src, dest);
  }

  async symlink(target: string, linkPath: string) {
    return (await this.parent()).symlink(target, linkPath);
  }

  async readlink(path: string) {
    return (await this.parent()).readlink(path);
  }
}
