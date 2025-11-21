import { AgentSystem, createHandler } from "agents/deep";
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

const RESEARCH_SUB_AGENT_DESCRIPTION =
  "Expert security analyst. Conducts deep-dive research on traffic and security events for a given Cloudflare zone, you must always provide the zone tag to the subagent. Give focused queries on specific topics - for multiple topics, call multiple agents in parallel using the task tool.";

const SECURITY_AGENT_BLUEPRINT = {
  name: "security-agent",
  description: RESEARCH_SUB_AGENT_DESCRIPTION,
  prompt: ANOMALYTICS_SUBAGENT_PROMPT,
  tags: ["security"]
};

const system = new AgentSystem({ defaultModel: "gpt-5-2025-08-07" });

system.addTool("get-current-window", getCurrentWindowTool, ["security"]);
system.addTool("set-time-window", setTimeWindowTool, ["security"]);
system.addTool("get-timeseries-text", getTimeseriesTextTool, ["security"]);
system.addTool("get-top-n-text", getTopNTextTool, ["security"]);

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

const DeepAgent = system.export();

export { DeepAgent };
export default createHandler({
  agentDefinitions: Array.from(system.agentRegistry.values())
});
