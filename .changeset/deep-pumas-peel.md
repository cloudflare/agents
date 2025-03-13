---
"agents-sdk": patch
---

Add RPC support with `unstable_callable` decorator for method exposure. This feature enables:

- Remote procedure calls from clients to agents
- Method decoration with `@unstable_callable` to expose agent methods
- Support for both regular and streaming RPC calls
- Type-safe RPC calls with automatic response handling
- Real-time streaming responses for long-running operations

Note: The `callable` decorator has been renamed to `unstable_callable` to indicate its experimental status.
