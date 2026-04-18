---
"@cloudflare/shell": patch
---

`Workspace` is now idempotent on duplicate construction for the same `{sql, namespace}` when the options that affect durable storage (`r2`, `r2Prefix`, `inlineThreshold`) agree. Previously, any second construction threw `Workspace namespace "<ns>" is already registered on this agent`, which wedged legitimate cases — most commonly Vite HMR re-evaluating a Durable Object's module against a still-live `ctx.storage.sql`, and helpers that accept a `sql` and construct a short-lived `Workspace` alongside an existing class-field one.

The guard is preserved where it actually catches a bug: if a second construction passes a different `r2`, `r2Prefix`, or `inlineThreshold`, the constructor throws with a message naming the disagreeing field and both values — because diverging storage options silently route large files to different R2 keys or classify them at different sizes, so reads through one instance would fail to find data written via the other.

`onChange` is intentionally not part of the consistency check — each `Workspace` instance calls its own listener for its own writes, which is the existing per-instance semantic.
