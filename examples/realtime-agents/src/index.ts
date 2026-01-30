import {
  DataKind,
  DeepgramSTT,
  ElevenLabsTTS,
  RealtimeAgent,
  RealtimeKitTransport,
  RealtimePipelineComponent,
  SpeakResponse
} from "agents/realtime";

import { type AgentContext, routeAgentRequest } from "agents";
import RealtimeKitClient from "@cloudflare/realtimekit";
import { env } from "cloudflare:workers";

const GATEWAY_ID = "aig-worker-testing";

export class RealtimeVoiceAgent extends RealtimeAgent {
  constructor(ctx: AgentContext, env: Env) {
    const rtk = new RealtimeKitTransport({
      meetingId: "bbb9e53e-c839-4c84-b0cd-b8ef18ed8da2"
    });
    const tts = new ElevenLabsTTS();
    const stt = new DeepgramSTT();

    super(ctx, env, env.AI, GATEWAY_ID);

    this.setPipeline([rtk, stt, this, tts, rtk]);
  }

  onRealtimeMeeting(meeting: RealtimeKitClient): void | Promise<void> {
    meeting.participants.joined.on("participantJoined", (participant) => {
      this.speak(`Participant Joined ${participant.name}`);
    });
  }

  async onRealtimeTranscript(text: string): Promise<SpeakResponse | undefined> {
    // Get conversation history to provide context to the LLM
    const history = this.getFormattedHistory(10); // Last 10 exchanges

    // Build prompt with conversation context
    const prompt = history
      ? `Previous conversation:\n${history}\n\nUser: ${text}\nAssistant:`
      : `User: ${text}\nAssistant:`;

    const response = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      prompt,
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
