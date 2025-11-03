---
"agents": patch
---

Add CLI entry point and tests for agents package

Introduces a new CLI for the agents package using yargs with the following commands (currently stubs, not yet implemented):

- `init` / `create` - Initialize an agents project
- `dev` - Start development server
- `deploy` - Deploy agents to Cloudflare
- `mcp` - The agents mcp server

Adds CLI test suite with comprehensive coverage for all commands and configurations. Updates package.json to register the CLI binary, adds test scripts for CLI testing, and includes yargs dependencies.
