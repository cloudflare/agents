---
"agents": minor
---

Support Pi 1.4: the Pi peer range is now `~1.4.0`. Pi 1.4 migrates SQLite session storage to a schema that Pi 1.3 cannot open, so a deployment cannot roll back past this release. See [Pi harness](https://developers.cloudflare.com/agents/harnesses/pi/).
