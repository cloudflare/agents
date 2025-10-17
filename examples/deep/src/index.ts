import { createDeepAgent, createHandler, makeOpenAI } from "agents/deep";
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
import { env } from "cloudflare:workers"; // yes this is a worker :)

const RESEARCH_SUB_AGENT_DESCRIPTION =
  "Expert security analyst. Conducts deep-dive research on traffic and security events for a given Cloudflare zone, you must always provide the zone tag to the subagent. Give focused queries on specific topics - for multiple topics, call multiple agents in parallel using the task tool.";

const subagent = {
  name: "security-agent",
  description: RESEARCH_SUB_AGENT_DESCRIPTION,
  prompt: ANOMALYTICS_SUBAGENT_PROMPT,
  model: "gpt-5-2025-08-07",
  tools: [
    getCurrentWindowTool,
    setTimeWindowTool,
    getTimeseriesTextTool,
    getTopNTextTool
  ]
};

// Main deep agent. Has planning, filesystem and subagent tools.
const DeepAgent = createDeepAgent({
  provider: makeOpenAI(env.OPENAI_API_KEY),
  subagents: [subagent],
  systemPrompt: ANOMALY_MAIN_AGENT_PROMPT,
  model: "gpt-5-2025-08-07"
});

export { DeepAgent };
export default createHandler();
