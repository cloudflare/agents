---
"agents": patch
---

`agents/models/opencode`: keep Cloudflare models working on OpenCode 2.2.1, which no longer bundles `@ai-sdk/vercel`; the provider now names `gitlab-ai-provider`, which every OpenCode release from 2.0.24 to 2.2.1 loads in-process. See [the OpenCode harness example](https://github.com/cloudflare/agents/blob/main/examples/next/harnesses/opencode/README.md#what-it-shows).
