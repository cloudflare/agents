---
"agents": patch
---

perf(sessions): `updateMessage()` recognises an unchanged row without reading it back. The core remembers the stored form of the rows this object wrote most recently (bounded to 8 MiB across sessions, oldest first), so re-sending one of them — a client tool update, an approval, an echoed transcript — is decided in memory: zero rows read for a no-op, and a changed update of a multi-row message no longer reads its continuations first. The memo is dropped by delete, clear, import, legacy migration and the sync aperture's `abandon()`, so a rolled-back write is never mistaken for the stored row; a cold object falls back to the full byte-exact compare.
