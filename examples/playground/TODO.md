# Playground Improvements

## Make Docs-Only Demos Interactive

- [x] **Live AI Chat** - Working chat with Workers AI (glm-4.7-flash), streaming, and client-side tools
- [x] **MCP Server** - Real MCP server at /mcp-server with tools (roll_dice, generate_uuid, word_count, hash_text) and resources
- [x] **MCP Client** - Connects to the playground's own MCP server, discovers tools via onMcpUpdate, calls them
- [x] **Workflow Demos** - Interactive multi-step workflow simulation and approval patterns
- [x] **Email Demos** - Real email receiving and secure replies via Cloudflare Email Routing
- [x] **Workers Pattern** - Interactive fan-out demo with ManagerAgent distributing to parallel FanoutWorkerAgents
- [x] **Pipeline Pattern** - Interactive 3-stage pipeline (Validate → Transform → Enrich) with per-stage output

## Missing SDK Features

- [ ] **Hibernation** - Demo showing hibernatable WebSockets and cost savings patterns
- [ ] **HTTP API** - Show `getAgentByName()` for HTTP-only access without WebSockets
- [ ] **Queue Patterns** - Rate limiting, batching, deduplication using the queue
- [x] **Multi-Agent** - One agent calling another agent (agent-to-agent communication)
- [x] **Routing Strategies** - Different agent naming patterns (per-user, per-session, shared)

## Developer Experience

- [ ] **Network Inspector** - Raw WebSocket frame viewer showing the actual protocol messages
- [ ] **Agent Inspector** - View internal tables (cf_agents_state, cf_agents_schedules, etc.)
- [ ] **State Diff View** - Highlight what changed in state updates
- [ ] **Copy-Paste Templates** - One-click starter code for each feature
- [x] **Code Examples** - "How it works" sections on every demo page with Shiki syntax-highlighted literate code snippets
- [x] **Rich Descriptions** - Fleshed-out descriptions with inline code tags on every demo page
- [x] **Back Navigation** - Back button on every demo page linking to the home page
- [x] **JSON Highlighting** - All JSON output uses Shiki syntax highlighting instead of plain CodeBlock
- [x] **Idle Cleanup** - All agents self-destroy after 15 minutes without connections (PlaygroundAgent base class)
