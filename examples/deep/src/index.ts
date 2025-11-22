// Imports
import { AgentSystem, subagents } from "agents/sys";
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

const SECURITY_AGENT_BLUEPRINT = {
  name: "security-agent",
  description:
    "Expert security analyst. Conducts deep-dive research on traffic and security events for a given Cloudflare zone, you must always provide the zone tag to the subagent. Give focused queries on specific topics - for multiple topics, call multiple agents in parallel using the task tool.",
  prompt: ANOMALYTICS_SUBAGENT_PROMPT,
  tags: ["security"]
};

const system = new AgentSystem({ defaultModel: "gpt-5-2025-08-07" })
  .defaults()
  .addTool(getCurrentWindowTool, ["security"])
  .addTool(setTimeWindowTool, ["security"])
  .addTool(getTimeseriesTextTool, ["security"])
  .addTool(getTopNTextTool, ["security"])
  .addAgent(SECURITY_AGENT_BLUEPRINT)
  .addAgent({
    name: "manager-agent",
    description: "Main agent",
    prompt: ANOMALY_MAIN_AGENT_PROMPT,
    tags: ["default"],
    config: { subagents: { subagents: [SECURITY_AGENT_BLUEPRINT] } }
  });

// CF setup
const { SystemAgent, Agency, handler } = system.export();
export { SystemAgent, Agency };
export default handler;
