# Agents MCP Server

[![Add to Cursor](https://img.shields.io/badge/Add%20to-Cursor-blue)](https://cursor.com/en-US/install-mcp?name=cloudflare-agents&config=eyJ1cmwiOiJodHBzOi8vYWdlbnRzLm1jcC5jbG91ZGZsYXJlLmNvbS9tY3AifQ%3D%3D)
[![Add to VS Code](https://img.shields.io/badge/Add%20to-VS%20Code-blue)](vscode:mcp/install?%7B%22name%22%3A%22cloudflare-agents%22%2C%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fagents.mcp.cloudflare.com%2Fmcp%22%7D)

This is an MCP server for anyone building with Agents SDK. It exposes just 1 tool.

```json
{
  "name": "search-agent-docs",
  "description": "Token efficient search of the Cloudflare Agents SDK documentation",
  "inputSchema": {
    "query": {
      "type": "string",
      "description": "query string to search for eg. 'agent hibernate', 'schedule tasks'"
    },
    "k": {
      "type": "number",
      "optional": true,
      "default": 5,
      "description": "number of results to return"
    }
  }
}
```

## Usage

Connect to this MCP server to any MCP Client that supports remote MCP servers.

```txt
https://agents.mcp.cloudflare.com/mcp
```

## How it works

It pulls the docs from Github, chunks them with a recursive chunker, and indexes them with Orama. The index is cached in KV for 1 day. Search is BM25 with stemming enabled for better results. This allows "hibernation" to match with "hibernate" allowing for more natural language queries.

## Development

To run this server locally, you can use the following command:

```bash
npm install
npm run dev
```

You can test this server with the MCP Inspector.

```bash
npx @modelcontextprotocol/inspector
```
