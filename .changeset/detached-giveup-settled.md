---
"agents": patch
---

Detached agent-tool runs given up after their child was torn down now count as settled, so the reconcile backbone stops re-arming forever, while a late finish (including a failed-callback retry) is still delivered. See [Detached (background) runs](https://github.com/cloudflare/agents/blob/main/docs/agents/agent-tools.md#detached-background-runs).
