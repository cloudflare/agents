import { createDeepAgent, createHandler, makeOpenAI } from "agents/deep";
import { internetSearch, readWebsite } from "./tools"; // I wrote 2 functions, ez pz
import { RESEARCH_AGENT_PROMPT, COMPETITIVE_ANALYSIS_PROMPT } from "./prompts";
import { env } from "cloudflare:workers"; // yes this is a worker :)

const RESEARCH_SUB_AGENT_DESCRIPTION =
  "Expert business intelligence researcher. Conducts deep-dive research on companies, products, pricing, and markets. Give focused queries on specific topics - for multiple topics, call multiple agents in parallel using the task tool.";

const subagent = {
  name: "research-agent",
  description: RESEARCH_SUB_AGENT_DESCRIPTION,
  prompt: RESEARCH_AGENT_PROMPT,
  model: "gpt-5-2025-08-07",
  tools: [internetSearch, readWebsite]
};

// Main deep agent. Has planning, filesystem and subagent tools.
const DeepAgent = createDeepAgent({
  provider: makeOpenAI(env.OPENAI_API_KEY),
  subagents: [subagent],
  systemPrompt: COMPETITIVE_ANALYSIS_PROMPT,
  model: "gpt-5-2025-08-07"
});

export { DeepAgent };
export default createHandler();
