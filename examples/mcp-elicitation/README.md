# MCP Elicitation Demo

An MCP server example showing elicitation with the Agents SDK. The MCP endpoint is served at `/mcp` (e.g. `http://localhost:8787/mcp` under `wrangler dev`).

Two tools demonstrate the two elicitation modes:

- **`increase-counter`** — form-mode: elicits an amount from the user via a `requestedSchema` form.
- **`connect-account`** — url-mode: sends a link for the user to open out-of-band, keeping the sensitive URL out of tool-result text.

Pair it with the [`mcp-client`](../mcp-client/) example, which renders both elicitation modes in a browser UI.
