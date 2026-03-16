# Codemode MCP

Wrap any MCP server with a single `code` tool using `codeMcpServer`.

- `/mcp` — original MCP server with raw tools (add, greet, list_items)
- `/codemode` — codemode-wrapped server with a single `code` tool

The LLM writes JavaScript that calls `codemode.add(...)`, `codemode.greet(...)`, etc.
