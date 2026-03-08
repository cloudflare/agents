import { Server, routePartykitRequest, type Connection } from "partyserver";
import { withVoiceInput, WorkersAIFluxSTT } from "@cloudflare/voice";

const InputServer = withVoiceInput(Server);

/**
 * Voice-to-text input server using PartyServer.
 *
 * Uses streaming STT to transcribe speech in real time. No TTS or LLM
 * pipeline — each utterance is transcribed and sent back to the client
 * immediately. The optional `onTranscript` hook lets you process each
 * utterance on the server side.
 */
export class VoiceInputAgent extends InputServer<Env> {
  streamingStt = new WorkersAIFluxSTT(this.env.AI);

  onTranscript(text: string, _connection: Connection) {
    console.log(`[VoiceInputAgent] Transcribed: "${text}"`);
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routePartykitRequest(request, env, { prefix: "agents" })) ||
      new Response("Not found", { status: 404 })
    );
  }
};
