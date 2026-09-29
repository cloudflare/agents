# `@cloudflare/voice` migration

`@cloudflare/voice` is deprecated. Voice now ships from the `agents` package.
The compatibility package remains supported throughout Agents 1.x and forwards
each existing entry to its replacement:

| Previous import            | Replacement           |
| -------------------------- | --------------------- |
| `@cloudflare/voice`        | `agents/voice`        |
| `@cloudflare/voice/client` | `agents/voice/client` |
| `@cloudflare/voice/react`  | `agents/voice/react`  |
| `@cloudflare/voice/errors` | `agents/voice/errors` |

The exported names, Voice wire protocol, and SQLite table names have not
changed. New projects only need to install `agents`:

```sh
npm install agents
```

See the [Voice reference](../agents/voice.md) for current usage.
