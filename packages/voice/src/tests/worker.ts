import { routeAgentRequest } from "agents";

export {
  TestVoiceAgent,
  TestStreamingVoiceAgent,
  TestVadRetryVoiceAgent,
  TestEotVoiceAgent
} from "./agents/voice";

export {
  TestVoiceInputAgent,
  TestStreamingVoiceInputAgent,
  TestEotVoiceInputAgent,
  TestRejectCallVoiceInputAgent
} from "./agents/voice-input";

export type Env = {
  TestVoiceAgent: DurableObjectNamespace;
  TestStreamingVoiceAgent: DurableObjectNamespace;
  TestVadRetryVoiceAgent: DurableObjectNamespace;
  TestEotVoiceAgent: DurableObjectNamespace;
  TestVoiceInputAgent: DurableObjectNamespace;
  TestStreamingVoiceInputAgent: DurableObjectNamespace;
  TestEotVoiceInputAgent: DurableObjectNamespace;
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
