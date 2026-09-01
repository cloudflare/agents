---
"agents": minor
---

Add the experimental `agents/sessions` Lifecycle capability with streamed and byte-budgeted history, branches, compaction, context blocks, opt-in search, and Sessions-owned content-addressed attachments. Attachment payloads use 1.5 MiB SQLite windows with an optional streamed R2 tier; standalone pointers have explicit lifetimes and no age sweep. Add Computer and legacy Shell projection to `SkillRegistry` so Agent Skills can be read and edited as workspace files without making Workspace own conversation data. Remove the superseded experimental SessionProvider, Postgres, and SessionManager stack. Existing `assistant_*` tables remain as `*__lifted_v1` rollback tombstones.
