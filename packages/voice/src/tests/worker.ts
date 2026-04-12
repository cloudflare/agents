import { routeAgentRequest } from "agents";

export { TestVoiceAgent } from "./agents/voice";

export {
  TestVoiceInputAgent,
  TestRejectCallVoiceInputAgent
} from "./agents/voice-input";

export type Env = {
  TestVoiceAgent: DurableObjectNamespace;
  TestVoiceInputAgent: DurableObjectNamespace;
  TestRejectCallVoiceInputAgent: DurableObjectNamespace;
};

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
