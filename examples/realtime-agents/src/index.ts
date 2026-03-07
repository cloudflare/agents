import {
  DeepgramSTT,
  ElevenLabsTTS,
  RealtimeAgent,
  RealtimeKitTransport,
  type RealtimeKitClient
} from "agents/realtime";

import { type AgentContext, routeAgentRequest } from "agents";
import { env } from "cloudflare:workers";
import { streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

const workersai = createWorkersAI({ binding: env.AI });

export class RealtimeVoiceAgent extends RealtimeAgent<Env> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    const rtk = new RealtimeKitTransport();

    // The keys for Elevenlabs and Deepgram can also be stored inside the AI Gateway with BYOK.
    const tts = new ElevenLabsTTS({
      apiKey: env.ELEVENLABS_API_KEY,
      voice_id: env.ELEVENLABS_VOICE_ID
    });
    const stt = new DeepgramSTT({ apiKey: env.DEEPGRAM_API_KEY });

    this.setPipeline([rtk, stt, this, tts, rtk], env.AI, env.AI_GATEWAY_ID); // AI_GATEWAY_ID is optional
  }

  onRealtimeMeeting(meeting: RealtimeKitClient): void | Promise<void> {
    // Set the agent's name in the meeting
    meeting.self.setName("Agent");

    // Speak when the agent joins the room
    meeting.self.on("roomJoined", () => {
      this.speak("Hello, I'm your AI assistant!");
    });
  }

  async onRealtimeTranscript(text: string) {
    const history = this.getTranscriptHistory();
    const { textStream } = streamText({
      model: workersai("@cf/meta/llama-3-8b-instruct"),
      messages: [
        {
          role: "system",
          content:
            "You are a helpful assistant, responding to the user with their speech transcribed as text."
        },
        ...history.map((entry) => ({
          role: entry.role,
          content: entry.text
        })),
        {
          role: "user",
          content: text
        }
      ]
    });

    return {
      text: textStream,
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
