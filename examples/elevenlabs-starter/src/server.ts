import { routeAgentRequest } from "agents";

// Each tab in the UI has its own Durable Object agent class.
// Exporting them here registers them with the Workers runtime.
export { VoiceChatAgent } from "./agents/voice-chat";
export { SoundscapeAgent } from "./agents/soundscape";
export { CharacterAgent } from "./agents/character";
export { MusicAgent } from "./agents/music";

export default {
  async fetch(request: Request, env: Env) {
    // routeAgentRequest matches /agents/* paths to the right DO
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
