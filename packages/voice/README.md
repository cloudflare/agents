# `@cloudflare/voice`

`@cloudflare/voice` is a deprecated compatibility package. Voice now ships from
the [`agents`](../agents) package.

Existing imports continue to work through re-exports:

| Previous import            | Replacement           |
| -------------------------- | --------------------- |
| `@cloudflare/voice`        | `agents/voice`        |
| `@cloudflare/voice/client` | `agents/voice/client` |
| `@cloudflare/voice/react`  | `agents/voice/react`  |
| `@cloudflare/voice/errors` | `agents/voice/errors` |

New projects should install and import only `agents`:

```sh
npm install agents
```

```typescript
import { withVoice, WorkersAIFluxSTT, WorkersAITTS } from "agents/voice";
import { VoiceClient } from "agents/voice/client";
import { useVoiceAgent } from "agents/voice/react";
```

The compatibility package preserves runtime and type identity. The Voice wire
protocol, provider contracts, and SQLite table names have not changed. It will
remain maintained throughout Agents 1.x.

See the [Voice reference](../../docs/agents/voice.md) for current usage.
