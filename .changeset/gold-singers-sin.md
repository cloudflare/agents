---
"hono-agents": patch
"agents": patch
---

update all dependencies

- remove the changesets cli patch, as well as updating node version, so we don't need to explicitly install newest npm
- lock mcp sdk version till we figure out how to do breaking changes correctly
- removes stray permissions block from release.yml
