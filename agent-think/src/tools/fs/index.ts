/**
 * Vendored, slimmed-down copy of `@cloudflare/fs-tools` from the
 * `hackspace` branch. Tools/edit-diff are verbatim; the
 * `WorkspaceFileStore` is adapted to the next-branch
 * `@cloudflare/workspace` shape (see `stores/workspace.ts`).
 */
export type { FileStat, FileStore } from "./stores/types";
export { WorkspaceFileStore, type WorkspaceLike } from "./stores/workspace";
export { createEditTool, type EditToolOptions } from "./tools/edit";
export { createReadTool, type ReadToolOptions } from "./tools/read";
export { createWriteTool, type WriteToolOptions } from "./tools/write";
