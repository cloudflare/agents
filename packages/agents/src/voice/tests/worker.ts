import { routeAgentRequest } from "agents";

export {
  TestVoiceAgent,
  TestDiagnosticVoiceAgent,
  TestEmptyResponseVoiceAgent,
  TestContextVoiceAgent,
  TestAiSdkFullStreamVoiceAgent,
  TestAiSdkTextStreamVoiceAgent,
  TestPcm24kVoiceAgent
} from "./agents/voice";

export {
  TestVoiceInputAgent,
  TestDiagnosticVoiceInputAgent,
  TestRejectCallVoiceInputAgent
} from "./agents/voice-input";

export type Env = {
  TestVoiceAgent: DurableObjectNamespace;
  TestDiagnosticVoiceAgent: DurableObjectNamespace;
  TestEmptyResponseVoiceAgent: DurableObjectNamespace;
  TestContextVoiceAgent: DurableObjectNamespace;
  TestAiSdkFullStreamVoiceAgent: DurableObjectNamespace;
  TestAiSdkTextStreamVoiceAgent: DurableObjectNamespace;
  TestPcm24kVoiceAgent: DurableObjectNamespace;
  TestVoiceInputAgent: DurableObjectNamespace;
  TestDiagnosticVoiceInputAgent: DurableObjectNamespace;
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
