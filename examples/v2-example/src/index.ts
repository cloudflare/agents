import { createAgentThread, createHandler, makeOpenAI } from "agents/v2";

const AgentThread = createAgentThread({
  provider: makeOpenAI(
    process.env.OPENAI_API_KEY ?? "",
    process.env.OPENAI_BASE_URL ?? ""
  )
});

export { AgentThread };
export default createHandler();
