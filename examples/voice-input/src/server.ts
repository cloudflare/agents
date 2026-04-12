import { Agent, routeAgentRequest, type Connection } from "agents";
import { withVoiceInput, WorkersAINova3STT } from "@cloudflare/voice";

const InputAgent = withVoiceInput(Agent);

/**
 * Voice-to-text input agent.
 *
 * Uses Nova 3 continuous STT to transcribe speech in real time. No TTS or
 * LLM pipeline — each utterance is transcribed and sent back to the client
 * immediately.
 */
export class VoiceInputAgent extends InputAgent<Env> {
  transcriber = new WorkersAINova3STT(this.env.AI);

  onTranscript(text: string, _connection: Connection) {
    console.log(`[VoiceInputAgent] Transcribed: "${text}"`);
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
