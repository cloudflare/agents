import type { Tool, ToolSet, UIMessage } from "ai";
import type { AgentToolRunState, MCPAITool, MCPAIToolSet } from "../index";
import type { useAgentToolEvents } from "../react";

// MCP tools remain structurally compatible with AI SDK Tool and ToolSet without
// making AI SDK types part of the published root declaration graph.
declare const mcpTool: MCPAITool;
mcpTool satisfies Tool;

declare const mcpTools: MCPAIToolSet;
mcpTools satisfies ToolSet;

// Agent-tool event consumers can opt into their framework's exact message-part
// union while the default published state remains framework-neutral.
type UIMessagePart = UIMessage["parts"][number];
declare const run: AgentToolRunState<UIMessagePart>;
run.parts satisfies UIMessage["parts"];

type AIEventState = ReturnType<typeof useAgentToolEvents<UIMessagePart>>;
declare const eventState: AIEventState;
eventState.unboundRuns[0].parts satisfies UIMessage["parts"];
eventState.runsById.example.parts satisfies UIMessage["parts"];
eventState.runsByToolCallId.example[0].parts satisfies UIMessage["parts"];
