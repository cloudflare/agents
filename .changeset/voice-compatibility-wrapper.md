---
"@cloudflare/voice": minor
---

Deprecate `@cloudflare/voice` in favor of the Voice exports in `agents`.

All existing entry points remain compatible re-export wrappers. Replace imports
from `@cloudflare/voice`, `/client`, `/react`, and `/errors` with the matching
`agents/voice` paths.
