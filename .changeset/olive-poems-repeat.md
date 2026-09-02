---
"@cloudflare/think": minor
---

Keep media eviction a context-window technique, separate from Sessions attachment storage.

The two were conflated. Sessions attachment storage is invisible and lossless: a large payload becomes an `attachment:sha256:` pointer and reads reconstruct it byte for byte. Media eviction is a decision about the model's context: once media has aged past `mediaEviction.keepRecentMessages` on the active path, Think removes it from the conversation so the model stops re-reading a large image every turn, and leaves `[evicted image/png, 812004 bytes; preserved at /attachments/evicted/<messageId>-<n>.png]` in its place. The raw bytes are written to the Workspace at that path with their real mime type, so the workspace `read` tool puts the actual image back in context when the agent deliberately reads it. The Sessions attachment reference is dropped in the same write, so the blob is reaped and the bytes live in exactly one place.

`mediaEviction: false` now means the model keeps seeing aged media. It no longer changes where Sessions keeps the bytes.

`minPartBytes` is now purely Think's context threshold and is no longer passed to Sessions as a storage setting. Where Sessions keeps a payload is decided by the 1.5 MiB row budget alone.

**Breaking:** `MediaEvictionConfig.externalizeToWorkspace` is removed. It was misnamed and inert; delete it from your config.
