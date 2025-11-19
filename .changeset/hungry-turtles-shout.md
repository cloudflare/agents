---
"agents": patch
---

Refactor MCP server table management in Agent class

Moved creation and deletion of the cf_agents_mcp_servers table from AgentMCPClientStorage to the Agent class. Removed redundant create and destroy methods from AgentMCPClientStorage and updated MCPClientManager to reflect these changes. Added comments to clarify usage in demo and test code.
