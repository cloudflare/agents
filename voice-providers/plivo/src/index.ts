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

// Keep a small allowance after estimated playback ends for network and Plivo
// queue latency before considering the agent silent.
const PLAYBACK_GRACE_MS = 1000;
const AGENT_PCM_BYTES_PER_SECOND = 16_000 * 2;

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

    // audioGated suppresses stale agent audio after local speech detection.
    // The gate remains raised until the agent confirms that it interrupted the
    // old pipeline or starts the next turn.
    let audioGated = false;

    // Barge-in is only armed while Plivo is estimated to still be playing
    // queued audio and only fires after a few consecutive loud frames, so line
    // noise, caller backchannels, and echo do not spuriously cut playback.
    let estimatedPlaybackEndAt = 0;
    let loudFrames = 0;

    const sendClearAudio = () => {
      estimatedPlaybackEndAt = 0;
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

            if (msg.type === "playback_interrupt") {
              // The agent's transcriber can detect speech that the local
              // energy heuristic misses. Clear Plivo unless the local path
              // already did, then release the gate at this ordered boundary.
              if (!audioGated) sendClearAudio();
              audioGated = false;
              loudFrames = 0;
              return;
            }

            if (
              msg.type === "status" &&
              (msg.status === "listening" ||
                msg.status === "thinking" ||
                msg.status === "speaking")
            ) {
              // Status transitions are ordered after the previous pipeline's
              // audio, so no stale chunk can follow this boundary.
              audioGated = false;
            }

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
            // Audio arriving before the agent's interruption boundary belongs
            // to the aborted response and must not refill Plivo's queue.
            return;
          }

          if (serverSocket.readyState === WebSocket.OPEN) {
            const now = Date.now();
            const durationMs =
              (event.data.byteLength / AGENT_PCM_BYTES_PER_SECOND) * 1000;
            estimatedPlaybackEndAt =
              Math.max(now, estimatedPlaybackEndAt) + durationMs;
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
            Date.now() < estimatedPlaybackEndAt + PLAYBACK_GRACE_MS;
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
          estimatedPlaybackEndAt = 0;
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
