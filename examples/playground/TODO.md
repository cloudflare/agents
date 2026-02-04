# Playground Improvements

## Make Docs-Only Demos Interactive

- [ ] **Live AI Chat** - Integrate actual OpenAI/Workers AI for a working chat demo with streaming responses and tool calls
- [ ] **Working MCP Server** - The playground itself could expose an MCP server that external clients (Cursor, Claude) can connect to
- [ ] **MCP Client Demo** - Connect to the playground's own MCP server to demonstrate the client flow
- [x] **Workflow Demos** - Interactive multi-step workflow simulation and approval patterns
- [x] **Email Demos** - Real email receiving and secure replies via Cloudflare Email Routing

## Missing SDK Features

- [ ] **Hibernation** - Demo showing hibernatable WebSockets and cost savings patterns
- [x] **Multi-Agent** - One agent calling another agent (agent-to-agent communication)
- [ ] **HTTP API** - Show `getAgentByName()` for HTTP-only access without WebSockets
- [ ] **Queue Patterns** - Rate limiting, batching, deduplication using the queue
- [x] **Routing Strategies** - Different agent naming patterns (per-user, per-session, shared)

## Developer Experience

- [ ] **Code Examples** - Bring back server/client code snippets in a better way (e.g., link to actual source files, modal view, or separate "Code" tab per demo)
- [ ] **Network Inspector** - Raw WebSocket frame viewer showing the actual protocol messages
- [ ] **Agent Inspector** - View internal tables (cf_agents_state, cf_agents_schedules, etc.)
- [ ] **State Diff View** - Highlight what changed in state updates
- [ ] **Copy-Paste Templates** - One-click starter code for each feature

## Polish

- [x] **Dark Mode Toggle** - Light/dark toggle fitting the grayscale theme
- [ ] **Mobile Sidebar** - Collapsible hamburger menu for mobile
- [ ] **Keyboard Shortcuts** - Navigate demos with arrow keys
- [ ] **Progress Indicator** - Show which demos the user has explored
