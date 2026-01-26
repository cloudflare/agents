---
"agents": minor
---

feat: add `enabled` prop to `useAgent` hook for conditional connections

This adds an `enabled` optional prop to `useAgent` that allows conditionally connecting to an Agent. When `enabled` is `false`, the connection will not be established. When it transitions from `false` to `true`, the connection is established. When it transitions from `true` to `false`, the connection is closed.

This is useful for:

- Auth-based conditional connections (only connect when authenticated)
- Feature flag based connections
- Lazy loading patterns

Usage:

```tsx
const agent = useAgent({
  agent: "my-agent",
  enabled: isAuthenticated // only connect when authenticated
});
```

Closes #533
