---
"agents": patch
"@cloudflare/think": patch
---

Load `just-bash` on demand in the skill script runner, so Workers that import `@cloudflare/think` or `agents/skills/runner` bundle without it installed. It's only needed to run Bash skill scripts.
