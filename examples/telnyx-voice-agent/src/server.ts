import { Agent, routeAgentRequest } from "agents";
import { withVoice, type VoiceTurnContext } from "@cloudflare/voice";
import {
  TelnyxJWTEndpoint,
  TelnyxSTT,
  TelnyxTTS
} from "@cloudflare/voice-telnyx";
import { streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

const VoiceAgent = withVoice(Agent);

const SYSTEM_PROMPT = `You are a friendly voice assistant powered by Cloudflare Workers and Telnyx. Keep responses concise, conversational, and suitable for spoken audio.`;

export class MyVoiceAgent extends VoiceAgent<Env> {
  transcriber = new TelnyxSTT({
    apiKey: this.env.TELNYX_API_KEY,
    language: "en",
    interimResults: true
  });

  tts = new TelnyxTTS({
    apiKey: this.env.TELNYX_API_KEY,
    voice: "Telnyx.NaturalHD.astra"
  });

  async onTurn(transcript: string, context: VoiceTurnContext) {
    const workersAi = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersAi("@cf/zai-org/glm-4.7-flash", {
        sessionAffinity: this.sessionAffinity
      }),
      system: SYSTEM_PROMPT,
      messages: [
        ...context.messages.map((message) => ({
          role: message.role as "user" | "assistant",
          content: message.content
        })),
        { role: "user" as const, content: transcript }
      ]
    });

    return result.textStream;
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/telnyx-token") {
      if (!env.TELNYX_CREDENTIAL_CONNECTION_ID) {
        return new Response(
          "TELNYX_CREDENTIAL_CONNECTION_ID is required for telephony",
          { status: 500 }
        );
      }

      const endpoint = new TelnyxJWTEndpoint({
        apiKey: env.TELNYX_API_KEY,
        credentialConnectionId: env.TELNYX_CREDENTIAL_CONNECTION_ID
      });
      return endpoint.handleRequest(request);
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
