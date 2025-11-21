// Imports
import { AgentSystem } from "agents/sys";
import {
  getCurrentWindowTool,
  setTimeWindowTool,
  getTimeseriesTextTool,
  getTopNTextTool
} from "./tools";
import {
  ANOMALYTICS_SUBAGENT_PROMPT,
  ANOMALY_MAIN_AGENT_PROMPT
} from "./prompts";

// Setup
const system = new AgentSystem({ defaultModel: "gpt-5-2025-08-07" });

system.addTool(getCurrentWindowTool, ["security"]);
system.addTool(setTimeWindowTool, ["security"]);
system.addTool(getTimeseriesTextTool, ["security"]);
system.addTool(getTopNTextTool, ["security"]);

const SECURITY_AGENT_BLUEPRINT = {
  name: "security-agent",
  description:
    "Expert security analyst. Conducts deep-dive research on traffic and security events for a given Cloudflare zone, you must always provide the zone tag to the subagent. Give focused queries on specific topics - for multiple topics, call multiple agents in parallel using the task tool.",
  prompt: ANOMALYTICS_SUBAGENT_PROMPT,
  tags: ["security"]
};

system.addAgent(SECURITY_AGENT_BLUEPRINT);

system.addAgent({
  name: "manager-agent",
  description: "Main agent",
  prompt: ANOMALY_MAIN_AGENT_PROMPT,
  tags: ["default"],
  config: {
    middleware: {
      subagents: {
        subagents: [SECURITY_AGENT_BLUEPRINT]
      }
    },
    tools: {}
  }
});

// CF setup
const { SystemAgent, handler } = system.export();
export { SystemAgent };
export default handler;
