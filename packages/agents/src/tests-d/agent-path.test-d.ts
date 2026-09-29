import {
  Agent,
  buildAgentPath,
  buildAgentUrl,
  type AgentPathStep,
  type BuildAgentPathOptions
} from "..";

declare const agent: Agent;
declare const options: BuildAgentPathOptions;

buildAgentPath(agent.selfPath, options) satisfies string;
buildAgentUrl("https://example.com", agent.selfPath, options) satisfies URL;

const path = [
  { className: "Inbox", name: "user-123" },
  { className: "Chat", name: "chat-abc" }
] as const satisfies ReadonlyArray<AgentPathStep>;

buildAgentPath(path) satisfies string;

// @ts-expect-error each path step requires a class name
buildAgentPath([{ name: "user-123" }]);
