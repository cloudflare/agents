---
"agents": minor
---

Add unified async authentication support to useAgent hook

The useAgent hook now automatically detects and handles both sync and async query patterns:

- Static queries work unchanged: `query: { token: "abc" }`
- Async queries with automatic caching: `query: async () => ({ token: await getToken() })`
- Built-in caching with configurable TTL and dependency tracking
- Zero breaking changes - existing code continues to work
