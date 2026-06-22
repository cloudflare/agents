import type { ToolSet, UIMessage } from "ai";
import type { AgentToolRunState, MCPAIToolSet } from "../index";
import type { useAgentToolEvents } from "../react";

// MCP tools remain structurally compatible with AI SDK ToolSet without making
// AI SDK types part of the published root declaration graph.
declare const mcpTools: MCPAIToolSet;
const aiTools: ToolSet = mcpTools;
void aiTools;

// Agent-tool event consumers can opt into their framework's exact message-part
// union while the default published state remains framework-neutral.
type UIMessagePart = UIMessage["parts"][number];
declare const run: AgentToolRunState<UIMessagePart>;
const parts: UIMessage["parts"] = run.parts;
void parts;

type AIEventState = ReturnType<typeof useAgentToolEvents<UIMessagePart>>;
declare const eventState: AIEventState;
const eventParts: UIMessage["parts"] = eventState.unboundRuns[0].parts;
void eventParts;
