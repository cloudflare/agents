# 15 — Workspace: virtual filesystem + file tools

Original: `@cloudflare/shell`'s Workspace (SQLite-backed virtual FS, optional
R2 spillover) + `think/tools/workspace.ts` (1.5k lines of tool defs: read,
write, edit, list, find, grep, delete, bash). The rebuild ports the virtual FS
over the KV port and the non-bash tools; `bash` stays behind the Sandbox port
(out of scope engine).

---

## 1. `domain/workspace/workspace.ts` — Workspace

### Model
- Path-keyed files: normalized POSIX-ish paths (`a/b/c.txt`), no leading `/`
  stored internally; both `/a/b` and `a/b` accepted in APIs. Reject `..`
  traversal and empty segments.
- File record: `{ path, content, mediaType?, encoding: "utf8" | "base64", size, createdAt, updatedAt }`.
  Binary content stored base64 with a mediaType.
- Directories are implicit (derived from paths); empty directories exist only
  as `.keep`-style markers if a caller creates them (mkdir → marker record).

### API
```ts
export interface WorkspaceEntry { path: string; size: number; updatedAt: number; mediaType?: string }
export interface Workspace {
  read(path: string): { content: string; encoding: "utf8" | "base64"; mediaType?: string } | null;
  write(path: string, content: string, opts?: { mediaType?: string; encoding?: "utf8" | "base64" }): void;
  delete(path: string): boolean;                       // also deletes dir markers under it when path is a dir
  exists(path: string): boolean;
  list(dir?: string, opts?: { recursive?: boolean }): WorkspaceEntry[];   // sorted by path
  find(glob: string): string[];                        // ** and * glob on paths
  grep(pattern: string, opts?: { glob?: string; maxMatches?: number }): Array<{ path: string; line: number; text: string }>;
  edit(path: string, oldString: string, newString: string, opts?: { replaceAll?: boolean }):
    { ok: true } | { ok: false; reason: "not_found" | "no_match" | "not_unique" };
  totalBytes(): number;
}
export function createWorkspace(deps: { store: KeyValueStore /* prefix "ws:" */; clock: Clock }): Workspace;
```
Glob semantics (shared with the fetch tool's allowlist, doc 16 — implement
once here, export `globToRegExp`): `**` matches any chars including `/`;
`*` matches any chars except `/`; other chars literal (escape regex specials).

### Tests
- path normalization + traversal rejection; write/read binary round-trip;
  list recursive vs not; find globs; grep with line numbers and glob filter;
  edit unique-match rule (`not_unique` when 2+ occurrences without
  replaceAll); persistence across instances.

---

## 2. `domain/workspace/tools.ts` — file tools for the model

`createWorkspaceTools(ws, opts?) → ToolSet` with `metadata.capability =
"workspace"`. Original behaviors to keep:

| tool    | input | behavior |
| ------- | ----- | -------- |
| `read`  | `{ path, offset?, limit? }` | text: line-numbered output (`N→content`), windowed by offset/limit (default 2000 lines); binary/PDF/image: return compact `{ path, mediaType, size, note }` (multimodal byte-passing is an adapter concern — keep the persisted result small). |
| `write` | `{ path, content }` | creates/overwrites; returns `{ path, bytes }`. |
| `edit`  | `{ path, old_string, new_string, replace_all? }` | maps Workspace.edit failures to instructive error values ("old_string not found", "appears N times — provide more context or replace_all"). |
| `list`  | `{ path?, recursive? }` | entries with sizes. |
| `find`  | `{ pattern }` | glob match on paths. |
| `grep`  | `{ pattern, glob?, max_matches? }` | regex search, `path:line: text` rows, bounded (default 100). |
| `delete`| `{ path }` | `{ deleted: boolean }`. |

- All outputs bounded by `truncateForModel` (~8k chars default per tool).
- Invalid regex/glob → error value, not throw.
- `bash` intentionally omitted; when a Sandbox port is provided, expose
  `createBashTool(sandbox, ws)` later (documented seam, not built now).

### Tests
- read line numbering + windowing; edit error phrasing; grep bounds; outputs
  truncated; tools validate inputs via zod.
