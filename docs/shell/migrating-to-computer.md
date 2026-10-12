# Migrating from `@cloudflare/shell` to `@cloudflare/computer`

`@cloudflare/shell` is deprecated. Its replacement for agent workspaces is [`@cloudflare/computer`](https://github.com/cloudflare/computer). Computer adds a durable filesystem, shell, JavaScript and container execution backends, git, and AI SDK tools to a Durable Object.

The two packages use different tables, so switching packages does not move your data. Files written by a Shell `Workspace` stay in their old table until you copy them yourself. This page tells you where each package keeps its data, and gives a copy script you can adapt.

## What changes

- Computer only runs inside a Durable Object. It takes `ctx.storage`. D1, custom `SqlBackend`s, and `InMemoryFs` have no replacement.
- One Durable Object storage holds one Computer workspace. Shell's `namespace` option has no equivalent yet ([cloudflare/computer#219](https://github.com/cloudflare/computer/issues/219)).
- Computer keeps all file content in SQLite and does not write large files to R2 yet ([cloudflare/computer#217](https://github.com/cloudflare/computer/issues/217)). R2 mounts are read-only.
- Inside an isolate, code reads and writes files through `node:fs/promises` or a shell command. Computer has no `state.*` helper object. Modules you configure on the JavaScript backend cover anything else.
- There are no host-held git credentials for model-run `git` yet ([cloudflare/computer#218](https://github.com/cloudflare/computer/issues/218)). Host code can still pass `onAuth` to `workspace.git` calls.

## Where Shell stores data

Each Shell `Workspace` owns one table named `cf_workspace_<namespace>`, where `namespace` defaults to `default`. An index named `cf_workspace_<namespace>_parent` covers `parent_path`. The DDL lives in `ensureInit()` in [`packages/shell/src/filesystem.ts`](https://github.com/cloudflare/agents/blob/main/packages/shell/src/filesystem.ts):

```sql
CREATE TABLE cf_workspace_default (
  path             TEXT PRIMARY KEY,
  parent_path      TEXT NOT NULL,
  name             TEXT NOT NULL,
  type             TEXT NOT NULL CHECK(type IN ('file','directory','symlink')),
  mime_type        TEXT NOT NULL DEFAULT 'text/plain',
  size             INTEGER NOT NULL DEFAULT 0,
  storage_backend  TEXT NOT NULL DEFAULT 'inline' CHECK(storage_backend IN ('inline','r2')),
  r2_key           TEXT,
  target           TEXT,
  content_encoding TEXT NOT NULL DEFAULT 'utf8',
  content          TEXT,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  modified_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
```

- A row with `storage_backend = 'inline'` holds its content in `content`. That content is UTF-8 text when `content_encoding = 'utf8'` and base64 when `content_encoding = 'base64'`.
- A row with `storage_backend = 'r2'` holds only metadata. The bytes are in your R2 bucket under `r2_key`, which follows the pattern `{r2Prefix ?? name}/{namespace}{path}`.
- Symlinks store their target in `target`.
- Timestamps are Unix seconds.

Think agents built before the switch used the `default` namespace, so their files are in `cf_workspace_default`.

## Where Computer stores data

Computer's tables all start with `vfs_` or `_vfs_`, so they never collide with `cf_workspace_*`. Both sets of tables can live in the same Durable Object while you migrate.

Files are inodes (`vfs_nodes`) that directory entries (`vfs_dirents`) link together. Each file's content is split into content-addressed chunks (`vfs_chunks` → `vfs_blobs` / `vfs_blob_bytes`). Sync and bookkeeping state lives in `vfs_meta`, `vfs_changes`, `vfs_manifests`, and the `_vfs_*` tables. The schema version is in `vfs_meta` under `schema_version`.

The schema is documented in [`docs/03_filesystem_schema.md`](https://github.com/cloudflare/computer/blob/main/docs/03_filesystem_schema.md). The DDL that ships is in [`packages/dofs/src/schema/`](https://github.com/cloudflare/computer/tree/main/packages/dofs/src/schema): `core.ts` for the filesystem tables, `sync.ts` for sync state, and `migrations.ts` for version upgrades.

Do not insert rows into the `vfs_*` tables by hand. Chunk hashes, the revision counter, and the change log have to agree with each other. Write through `workspace.fs` and Computer keeps them consistent.

## Copying a Shell workspace into Computer

Construct both workspaces on the same storage, walk the Shell table, and write each entry through `workspace.fs`. If your Shell workspace wrote large files to R2, pass the same `r2` and `name` (or `r2Prefix`) options so `readFileBytes` can fetch them.

`root` is where the files land. Think, and Computer's tools and backends, work under `/workspace`, so a Think agent should copy its old files there: Shell's `/notes.md` becomes `/workspace/notes.md`. Pass `"/"` to keep the paths as they were.

```ts
import { Workspace as ShellWorkspace } from "@cloudflare/shell";
import { Workspace } from "@cloudflare/computer";

// Shell resolves a relative target against the link's directory and never
// goes above `/`.
function resolveTarget(link: string, target: string): string {
  if (target.startsWith("/")) return target;
  const parts = link.split("/").slice(1, -1);
  for (const part of target.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "" && part !== ".") parts.push(part);
  }
  return `/${parts.join("/")}`;
}

async function copyShellWorkspace(
  from: ShellWorkspace,
  to: Workspace,
  root = "/workspace"
): Promise<void> {
  const at = (path: string) => (root === "/" ? path : `${root}${path}`);
  await to.fs.mkdir(root, { recursive: true });
  // glob returns rows ordered by path, so parents come before children.
  for (const entry of await from.glob("/**")) {
    if (entry.path === "/") continue;
    if (entry.type === "directory") {
      await to.fs.mkdir(at(entry.path), { recursive: true });
    } else if (entry.type === "symlink" && entry.target) {
      // Resolve the target the way Shell does, then move it with the files.
      const target = resolveTarget(entry.path, entry.target);
      await to.fs.symlink(at(target), at(entry.path));
    } else {
      const bytes = await from.readFileBytes(entry.path);
      if (bytes !== null) await to.fs.writeFile(at(entry.path), bytes);
    }
  }
}
```

Run the copy once, for example from `onStart`, and record that it ran so it does not repeat:

```ts
async onStart() {
  if (this.ctx.storage.kv.get("shellMigrated")) return;
  const shell = new ShellWorkspace({ sql: this.ctx.storage.sql, name: () => this.name });
  await copyShellWorkspace(shell, this.workspace);
  this.ctx.storage.kv.put("shellMigrated", true);
}
```

Things the copy does not keep:

- `created_at` and `modified_at`. Computer stamps the time of the copy.
- `mime_type`. Computer does not store a MIME type per file.

After you have checked the copied files, read the `r2_key` of every row with `storage_backend = 'r2'` and delete those R2 objects, then drop the old table with `DROP TABLE cf_workspace_default`. Delete exact keys, not a whole prefix: Shell workspaces in other namespaces can share the same prefix.
