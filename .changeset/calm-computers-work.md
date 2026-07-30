---
"@cloudflare/think": minor
---

Add an opt-in `@cloudflare/think/experimental/computer` integration using
Computer's `useThink` compatibility surface. Locally owned Computers are
assigned directly to `this.workspace`; remote `getWorkspace()` clients use a
compatibility adapter. Think's default `@cloudflare/shell` workspace, direct
`this.workspace` methods, stored data, and `just-bash` tool remain unchanged.
The experimental Computer uses separate storage and does not migrate legacy
workspace data.
