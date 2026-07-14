# Workspace

A durable, path-keyed virtual filesystem — the "disk" an agent's tools read and
write — plus the file tools that operate on it. It is a filesystem that happens to
expose tools, not a kind of tool. See the [context map](../../../CONTEXT-MAP.md).

## Language

**Workspace**:
A path-keyed virtual filesystem stored over the KeyValueStore; the durable disk an
agent owns.
_Avoid_: filesystem, disk, storage

**File record**:
The stored unit for one path: content, media type, encoding (utf8/base64), size,
and timestamps. Binary content is stored base64 with a media type.
_Avoid_: file, blob

**WorkspaceEntry**:
The listing projection of a file (path, size, updated-at, media type) — what a
directory listing returns.

**Dir marker**:
A placeholder record that makes an otherwise-implicit empty directory exist.
_Avoid_: directory record, folder

**Workspace tools**:
The tool set (capability `workspace`) exposing read/write/edit/list/find/grep/
delete over the workspace.
_Avoid_: file tools (loosely)

**globToRegExp**:
The single shared glob-to-regex convention (`**` matches across `/`, `*` does not)
defined here and reused by the fetch allowlist.
