import {
  DeepgramSTT,
  ElevenLabsTTS,
  RealtimeAgent,
  RealtimeKitTransport,
  type RealtimeKitClient
} from "agents/realtime";

import { type AgentContext, routeAgentRequest } from "agents";
import { env } from "cloudflare:workers";

export class RealtimeVoiceAgent extends RealtimeAgent<Env> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    const rtk = new RealtimeKitTransport();

    // The keys for Elevenlabs and Deepgram can also be stored inside the AI Gateway with BYOK.
    const tts = new ElevenLabsTTS({ apiKey: env.ELEVENLABS_API_KEY });
    const stt = new DeepgramSTT({ apiKey: env.DEEPGRAM_API_KEY });

    this.setPipeline([rtk, stt, this, tts, rtk], env.AI, env.AI_GATEWAY_ID);
  }

  onRealtimeMeeting(meeting: RealtimeKitClient): void | Promise<void> {
    meeting.participants.joined.on("participantJoined", (participant) => {
      this.speak(`Participant Joined ${participant.name}`);
    });
  }

  async onRealtimeTranscript(text: string) {
    const history = this.getTranscriptHistory();

    const response = await env.AI.run("@cf/openai/gpt-oss-20b", {
      instructions:
        "You are a helpful assistant, provide a response to the user.",
      input: history
        .map((h) => ({ role: h.role, content: h.text }))
        .concat({ role: "user", content: text }),
      stream: true
    });

    return {
      text: response,
      canInterrupt: true
    };
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      const response = await routeAgentRequest(request, env);
      if (response) {
        return response;
      }
    } catch (e) {
      console.error(e);
    }

    return new Response("failed to handle request", { status: 400 });
  }
} satisfies ExportedHandler<Env>;
