import { routeAgentRequest, type AgentContext } from "agents";
import {
  RealtimeAgent,
  DeepgramSTT,
  ElevenLabsTTS,
  WebSocketTransport,
  REALTIME_WS_TAG,
  type SpeakResponse
} from "agents/realtime";

const GATEWAY_ID = "ramyak-test";

// ─── VoiceAgent ─────────────────────────────────────────────────────────────

export class VoiceAgent extends RealtimeAgent<Env> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);

    this.setPipeline(
      [
        new WebSocketTransport(this),
        new DeepgramSTT({ apiKey: env.DEEPGRAM_API_KEY }),
        this,
        new ElevenLabsTTS({ apiKey: env.ELEVENLABS_API_KEY }),
        new WebSocketTransport(this)
      ],
      env.AI,
      GATEWAY_ID
    );
  }

  /**
   * Send a message only to browser clients, not to the pipeline server connection.
   */
  private sendToClients(message: string) {
    const pipelineConns = new Set<string>();
    for (const conn of this.getConnections(REALTIME_WS_TAG)) {
      pipelineConns.add(conn.id);
    }
    for (const conn of this.getConnections()) {
      if (!pipelineConns.has(conn.id)) {
        conn.send(message);
      }
    }
  }

  async onRealtimeTranscript(text: string): Promise<SpeakResponse | undefined> {
    console.log(`[Transcript] User said: "${text}"`);

    this.sendToClients(
      JSON.stringify({ type: "transcription", source: "client", text })
    );

    const response = (await this.env.AI.run("@cf/meta/llama-3-8b-instruct", {
      messages: [
        {
          role: "system",
          content:
            "You are a helpful voice assistant. Keep your responses concise and conversational, suitable for spoken dialogue. Respond in 1-2 sentences."
        },
        { role: "user", content: text }
      ]
    })) as { response?: string };

    const agentText = (response.response || "").trim();
    if (!agentText) return undefined;

    this.sendToClients(
      JSON.stringify({
        type: "transcription",
        source: "agent",
        text: agentText
      })
    );

    return { text: agentText, canInterrupt: true };
  }
}

// ─── Worker fetch handler ───────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
