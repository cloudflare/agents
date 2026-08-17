---
"@cloudflare/think": patch
---

Emit workspace image reads as `image-data` model content so AI SDK v6 routes them as images, while preserving `file-data` output for PDFs.

Existing consumers that inspect raw workspace tool content must handle `image-data` for images; PDFs continue to use `file-data`. Normal tool callers require no change.
