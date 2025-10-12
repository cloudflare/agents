import { createDeepAgent, createHandler, makeOpenAI } from "agents/deep";
import { internet_search, read_website } from "./tools";
import { research_agent_prompt, competitive_analysis_prompt } from "./prompts";
import { env } from "cloudflare:workers"; // yes this is a worker :)

const research_sub_agent_description =
  "Expert business intelligence researcher. Conducts deep-dive research on companies, products, pricing, and markets. Give focused queries on specific topics - for multiple topics, call multiple agents in parallel using the task tool.";

const subagent = {
  name: "research-agent",
  description: research_sub_agent_description,
  prompt: research_agent_prompt,
  model: "gpt-5-2025-08-07",
  tools: { internet_search, read_website }
};

// Main deep agent. Has planning, filesystem and subagent tools.
const DeepAgent = createDeepAgent({
  provider: makeOpenAI(env.OPENAI_API_KEY),
  subagents: [subagent],
  systemPrompt: competitive_analysis_prompt,
  model: "gpt-5-2025-08-07"
});

export { DeepAgent };
export default createHandler();
