/**
 * Plivo audio streaming adapter for the Agents voice pipeline.
 *
 * Bridges Plivo's bidirectional audio streaming WebSocket protocol to
 * VoiceAgent's binary PCM + JSON voice protocol.
 *
 * Plivo sends base64-encoded mulaw 8kHz audio. The adapter decodes mulaw and
 * resamples 8→16kHz before forwarding to VoiceAgent. Agent PCM (16kHz) is
 * resampled back to 8kHz and mulaw-encoded before playback.
 *
 * Use contentType="audio/x-mulaw;rate=8000" in the Plivo Stream XML.
 *
 * @example
 * ```typescript
 * import { withVoice } from "@cloudflare/voice";
 * import { PlivoAdapter } from "@cloudflare/voice-plivo";
 *
 * export class MyAgent extends VoiceAgent<Env> {
 *   async onTurn(transcript: string, context: VoiceTurnContext) {
 *     return "Hello! How can I help you?";
 *   }
 * }
 *
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     if (new URL(request.url).pathname === "/plivo") {
 *       return PlivoAdapter.handleRequest(request, env, "MyAgent");
 *     }
 *     return routeAgentRequest(request, env);
 *   }
 * };
 * ```
 */

import {
  meanSquaredEnergy,
  mulawBase64ToPcm16,
  pcm16ToMulawBase64
} from "./audio/utils.js";
import type {
  PlivoDtmfMessage,
  PlivoMediaMessage,
  PlivoStartMessage
} from "./types.js";

export { setupPlivoApplication, type PlivoSetupConfig } from "./setup.js";

export interface PlivoAdapterOptions {
  /**
   * Instance name for the VoiceAgent Durable Object.
   * Defaults to the Plivo Call ID (each call gets its own agent instance).
   */
  instanceName?: string;
}

// Energy threshold for speech detection — filters ambient mic noise.
// Mean squared amplitude > 250,000 ≈ RMS > 500 out of ±32,767.
const SPEECH_ENERGY_THRESHOLD = 250_000;

// Consecutive loud frames required before treating inbound audio as real
// caller speech (≈60ms at 8kHz/20ms frames) — debounces transient noise.
const SPEECH_DEBOUNCE_FRAMES = 3;

// Only treat inbound speech as a barge-in if the agent sent audio within this
// window, i.e. it is actually speaking and there is something to interrupt.
const AGENT_SPEAKING_WINDOW_MS = 1000;

/**
 * Bridges Plivo audio streaming to a VoiceAgent Durable Object.
 */
export class PlivoAdapter {
  /**
   * Handle an incoming Plivo audio streaming WebSocket connection.
   * Routes the audio to a VoiceAgent Durable Object.
   */
  static handleRequest(
    request: Request,
    env: object,
    agentName: string,
    options?: PlivoAdapterOptions
  ): Response {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const { 0: plivoSocket, 1: serverSocket } = new WebSocketPair();

    serverSocket.accept();

    let streamId: string | null = null;
    let agentSocket: WebSocket | null = null;

    // audioGated suppresses agent audio forwarded to Plivo during an active
    // barge-in. Raised by inbound speech energy detection; cleared
    // automatically when the agent sends its next audio chunk.
    let audioGated = false;

    // Barge-in is only armed while the agent is actually speaking (we sent it
    // audio recently) and only fires after a few consecutive loud frames, so
    // line noise, caller backchannels, and echo of the agent's own audio
    // don't spuriously cut playback mid-response.
    let lastAgentAudioAt = 0;
    let loudFrames = 0;

    const sendClearAudio = () => {
      if (serverSocket.readyState === WebSocket.OPEN) {
        serverSocket.send(JSON.stringify({ event: "clearAudio", streamId }));
      }
    };

    const connectToAgent = async (instanceId: string) => {
      const namespace = (env as Record<string, unknown>)[agentName] as
        | DurableObjectNamespace
        | undefined;
      if (!namespace) {
        console.error(
          `[PlivoAdapter] DO namespace "${agentName}" not found in env`
        );
        return;
      }

      const id = namespace.idFromName(instanceId);
      const stub = namespace.get(id);

      const agentUrl = new URL(request.url);
      agentUrl.pathname = `/agents/${agentName.toLowerCase()}/${instanceId}`;
      agentUrl.protocol = "https:";

      const agentResp = await stub.fetch(
        new Request(agentUrl.toString(), {
          headers: { Upgrade: "websocket" }
        })
      );

      const ws = agentResp.webSocket;
      if (!ws) {
        console.error("[PlivoAdapter] Failed to get WebSocket from agent");
        return;
      }

      ws.accept();
      agentSocket = ws;

      ws.addEventListener("message", (event) => {
        if (!streamId) return;

        if (typeof event.data === "string") {
          try {
            const msg = JSON.parse(event.data) as Record<string, unknown>;

            if (
              serverSocket.readyState === WebSocket.OPEN &&
              (msg.type === "transcript" ||
                msg.type === "transcript_end" ||
                msg.type === "status")
            ) {
              serverSocket.send(
                JSON.stringify({
                  event: "checkpoint",
                  streamId,
                  name: JSON.stringify(msg)
                })
              );
            }
          } catch {
            // ignore non-JSON
          }
        } else if (event.data instanceof ArrayBuffer) {
          if (audioGated) {
            // Discard first chunk after barge-in (may be stale TTS in flight)
            // and clear the gate so subsequent chunks flow through.
            audioGated = false;
            return;
          }

          if (serverSocket.readyState === WebSocket.OPEN) {
            lastAgentAudioAt = Date.now();
            serverSocket.send(
              JSON.stringify({
                event: "playAudio",
                media: {
                  contentType: "audio/x-mulaw",
                  sampleRate: 8000,
                  payload: pcm16ToMulawBase64(new Int16Array(event.data))
                }
              })
            );
          }
        }
      });

      ws.addEventListener("close", () => {
        if (serverSocket.readyState === WebSocket.OPEN) {
          serverSocket.close();
        }
      });

      ws.send(JSON.stringify({ type: "start_call" }));
    };

    serverSocket.addEventListener("message", async (event) => {
      if (typeof event.data !== "string") return;

      let msg: { event: string };
      try {
        msg = JSON.parse(event.data) as { event: string };
      } catch {
        return;
      }

      switch (msg.event) {
        case "start": {
          const startMsg = msg as unknown as PlivoStartMessage;
          streamId = startMsg.start.streamId;

          const instanceId =
            options?.instanceName ?? startMsg.start.callId ?? "default";
          await connectToAgent(instanceId);
          break;
        }

        case "media": {
          const mediaMsg = msg as unknown as PlivoMediaMessage;
          if (mediaMsg.media.track !== "inbound") break;

          const pcm16k = mulawBase64ToPcm16(mediaMsg.media.payload);

          // Barge-in: clear playback only when the agent is actually speaking
          // and the caller produces sustained speech. Gating on both avoids
          // cutting the agent mid-response on noise, backchannels, or echo.
          loudFrames =
            meanSquaredEnergy(pcm16k) > SPEECH_ENERGY_THRESHOLD
              ? loudFrames + 1
              : 0;
          const agentSpeaking =
            Date.now() - lastAgentAudioAt < AGENT_SPEAKING_WINDOW_MS;
          if (
            !audioGated &&
            agentSpeaking &&
            loudFrames >= SPEECH_DEBOUNCE_FRAMES
          ) {
            audioGated = true;
            loudFrames = 0; // require a fresh burst before the next barge-in
            sendClearAudio();
          }

          if (agentSocket?.readyState === WebSocket.OPEN) {
            agentSocket.send(pcm16k.buffer as ArrayBuffer);
          }
          break;
        }

        case "dtmf": {
          const dtmfMsg = msg as unknown as PlivoDtmfMessage;
          if (agentSocket?.readyState === WebSocket.OPEN) {
            agentSocket.send(JSON.stringify(dtmfMsg));
          }
          break;
        }

        case "clearedAudio": {
          break;
        }

        // Plivo does not send a stop event — call end is detected via
        // WebSocket close.
      }
    });

    serverSocket.addEventListener("close", () => {
      if (agentSocket?.readyState === WebSocket.OPEN) {
        agentSocket.send(JSON.stringify({ type: "end_call" }));
        agentSocket.close();
      }
    });

    return new Response(null, {
      status: 101,
      webSocket: plivoSocket
    });
  }
}
