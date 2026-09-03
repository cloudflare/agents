---
"@cloudflare/think": minor
---

Keep media eviction a context-window technique, separate from how Sessions stores a message.

How Sessions lays a message out in rows is invisible and lossless: a message too large for one row is split across continuation rows and reassembled byte for byte. Media eviction is a decision about the model's context: once media has aged past `mediaEviction.keepRecentMessages` on the active path, Think removes it from the conversation so the model stops re-reading a large image every turn, and leaves `[evicted image/png, 812004 bytes; preserved at /attachments/evicted/<messageId>-<n>.png]` in its place. The raw bytes are written to the Workspace at that path with their real mime type, so the workspace `read` tool puts the actual image back in context when the agent deliberately reads it. The rewritten message no longer carries the payload, so the bytes live in exactly one place.

`mediaEviction: false` now means the model keeps seeing aged media. It no longer changes where Sessions keeps the bytes.

`minPartBytes` is Think's context threshold and is no longer passed to Sessions as a storage setting. The marker text and the `/attachments/evicted/<id>-<n>.<ext>` paths are unchanged, so old markers keep resolving.

`MediaEvictionConfig.externalizeToWorkspace` is deprecated and ignored: evicted bytes are always preserved. Existing configurations keep compiling.

`WorkspaceLike.writeFileBytes` is optional. Eviction and skills projection need it to write raw bytes; a custom workspace without it keeps working and those two features log once and stand down.
