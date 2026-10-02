---
"@cloudflare/think": patch
---

Think can write server-authored `messageMetadata` onto assistant messages, per agent or per turn, and recovery preserves metadata even when keys match built-in object properties. See [Think lifecycle hooks](https://github.com/cloudflare/agents/blob/main/docs/think/lifecycle-hooks.md).
