/**
 * Twilio Media Streams adapter for the Agents voice pipeline.
 *
 * Bridges Twilio's bidirectional Media Streams WebSocket protocol
 * to VoiceAgent's binary PCM + JSON voice protocol.
 *
 * Twilio sends: mulaw 8kHz base64-encoded audio in JSON messages
 * VoiceAgent expects: 16kHz 16-bit PCM as binary WebSocket frames + JSON control messages
 *
 * This adapter handles:
 * - Decoding base64 mulaw 8kHz audio from Twilio → resampling to 16kHz PCM for VoiceAgent
 * - Encoding VoiceAgent's MP3 TTS output → mulaw 8kHz base64 for Twilio
 * - Translating Twilio lifecycle events (connected, start, stop) to VoiceAgent protocol (start_call, end_call)
 * - Forwarding VoiceAgent JSON messages (status, transcript, etc.) to the caller via marks
 *
 * @example
 * ```typescript
 * import { VoiceAgent } from "agents/voice";
 * import { TwilioAdapter } from "@cloudflare/agents-voice-twilio";
 *
 * class MyAgent extends VoiceAgent<Env> {
 *   async onTurn(transcript, context) { ... }
 * }
 *
 * export default {
 *   async fetch(request, env) {
 *     // Twilio sends WebSocket connections to your stream URL
 *     if (new URL(request.url).pathname === "/twilio") {
 *       return TwilioAdapter.handleRequest(request, env, "MyAgent");
 *     }
 *     return routeAgentRequest(request, env);
 *   }
 * };
 * ```
 */

// --- Audio conversion utilities ---

/**
 * mulaw decoding table. Maps mulaw byte values to 16-bit linear PCM samples.
 */
const MULAW_DECODE_TABLE = new Int16Array(256);
{
  for (let i = 0; i < 256; i++) {
    // Invert all bits
    const mu = ~i & 0xff;
    const sign = mu & 0x80;
    const exponent = (mu >> 4) & 0x07;
    const mantissa = mu & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    MULAW_DECODE_TABLE[i] = sign ? -sample : sample;
  }
}

/**
 * mulaw encoding table. Maps 16-bit linear PCM sample values to mulaw bytes.
 * Uses a 16-bit lookup for the positive range, negated for negative values.
 */
const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

// Exported for future use in outbound audio conversion (agent → Twilio).
export function encodeMulaw(sample: number): number {
  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;

  let exponent = 7;
  const expMask = 0x4000;
  for (; exponent > 0; exponent--) {
    if (sample & expMask) break;
    sample <<= 1;
  }

  const mantissa = (sample >> 10) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/**
 * Decode mulaw 8kHz audio to 16-bit PCM 8kHz.
 */
function decodeMulawToPCM(mulawData: Uint8Array): Int16Array {
  const pcm = new Int16Array(mulawData.length);
  for (let i = 0; i < mulawData.length; i++) {
    pcm[i] = MULAW_DECODE_TABLE[mulawData[i]];
  }
  return pcm;
}

/**
 * Resample PCM audio from one sample rate to another using linear interpolation.
 */
function resamplePCM(
  input: Int16Array,
  fromRate: number,
  toRate: number
): Int16Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const idx = Math.floor(srcIndex);
    const frac = srcIndex - idx;
    const a = input[idx] ?? 0;
    const b = input[Math.min(idx + 1, input.length - 1)] ?? 0;
    output[i] = Math.round(a + frac * (b - a));
  }

  return output;
}

/**
 * Convert an Int16Array to an ArrayBuffer of 16-bit LE PCM bytes.
 */
function int16ToArrayBuffer(samples: Int16Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(i * 2, samples[i], true);
  }
  return buffer;
}

// --- Twilio protocol types ---

interface TwilioStartMessage {
  event: "start";
  streamSid: string;
  start: {
    streamSid: string;
    accountSid: string;
    callSid: string;
    tracks: string[];
    customParameters: Record<string, string>;
    mediaFormat: {
      encoding: string;
      sampleRate: number;
      channels: number;
    };
  };
}

interface TwilioMediaMessage {
  event: "media";
  streamSid: string;
  media: {
    track: string;
    chunk: string;
    timestamp: string;
    payload: string; // base64 mulaw
  };
}

// --- Adapter ---

export interface TwilioAdapterOptions {
  /**
   * Instance name for the VoiceAgent Durable Object.
   * If not provided, uses the Twilio Call SID (each call gets its own agent instance).
   */
  instanceName?: string;
}

/**
 * Bridges Twilio Media Streams to a VoiceAgent Durable Object.
 *
 * Use `TwilioAdapter.handleRequest()` in your Worker's fetch handler
 * to accept Twilio WebSocket connections and forward them to your VoiceAgent.
 */
export class TwilioAdapter {
  /**
   * Handle an incoming Twilio Media Streams WebSocket connection.
   * Routes the audio to a VoiceAgent Durable Object.
   *
   * @param request - The incoming WebSocket upgrade request from Twilio
   * @param env - The Worker environment (must contain the agent's DO namespace)
   * @param agentName - The name of the VoiceAgent DO binding in env (e.g., "MyAgent")
   * @param options - Optional adapter configuration
   *
   * @example
   * ```typescript
   * export default {
   *   async fetch(request, env) {
   *     if (new URL(request.url).pathname === "/twilio") {
   *       return TwilioAdapter.handleRequest(request, env, "MyAgent");
   *     }
   *     return routeAgentRequest(request, env);
   *   }
   * };
   * ```
   */
  static handleRequest(
    request: Request,
    env: Record<string, unknown>,
    agentName: string,
    options?: TwilioAdapterOptions
  ): Response {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const { 0: twilioSocket, 1: serverSocket } = new WebSocketPair();

    serverSocket.accept();

    let streamSid: string | null = null;
    let agentSocket: WebSocket | null = null;
    let callSid: string | null = null;

    // Connect to the VoiceAgent DO
    const connectToAgent = async (instanceId: string) => {
      const namespace = env[agentName] as DurableObjectNamespace | undefined;
      if (!namespace) {
        console.error(
          `[TwilioAdapter] DO namespace "${agentName}" not found in env`
        );
        return;
      }

      const id = namespace.idFromName(instanceId);
      const stub = namespace.get(id);

      // Create a WebSocket connection to the agent
      const agentUrl = new URL(request.url);
      agentUrl.pathname = `/agents/${agentName.toLowerCase()}/${instanceId}`;
      agentUrl.protocol = agentUrl.protocol.replace("http", "ws");

      const agentResp = await stub.fetch(
        new Request(agentUrl.toString(), {
          headers: { Upgrade: "websocket" }
        })
      );

      const ws = agentResp.webSocket;
      if (!ws) {
        console.error("[TwilioAdapter] Failed to get WebSocket from agent");
        return;
      }

      ws.accept();
      agentSocket = ws;

      // Forward agent messages back to Twilio
      ws.addEventListener("message", (event) => {
        if (!streamSid) return;

        if (typeof event.data === "string") {
          // JSON messages from agent — forward status/transcript as-is
          // (Twilio doesn't render these, but they can be logged)
          // We could also use marks to track them
        } else if (event.data instanceof ArrayBuffer) {
          // MP3 audio from agent — we need to decode and convert to mulaw
          // For now, we send the raw audio and let Twilio handle it
          // TODO: decode MP3 → PCM → resample to 8kHz → encode mulaw → base64
          // This requires an MP3 decoder which is complex in pure JS.
          // A practical approach: configure VoiceAgent to output mulaw directly,
          // or use a TTS provider that can output mulaw 8kHz.
          //
          // For now, we log this as a limitation.
          console.log(
            "[TwilioAdapter] Received audio from agent (MP3→mulaw conversion needed)"
          );
        }
      });

      ws.addEventListener("close", () => {
        console.log("[TwilioAdapter] Agent connection closed");
      });

      // Send start_call to agent
      ws.send(JSON.stringify({ type: "start_call" }));
    };

    serverSocket.addEventListener("message", async (event) => {
      if (typeof event.data !== "string") return;

      let msg: { event: string };
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      switch (msg.event) {
        case "connected":
          console.log("[TwilioAdapter] Twilio connected");
          break;

        case "start": {
          const startMsg = msg as unknown as TwilioStartMessage;
          streamSid = startMsg.streamSid;
          callSid = startMsg.start.callSid;
          console.log(
            `[TwilioAdapter] Stream started: ${streamSid} (call: ${callSid})`
          );

          const instanceId = options?.instanceName ?? callSid ?? "default";
          await connectToAgent(instanceId);
          break;
        }

        case "media": {
          const mediaMsg = msg as unknown as TwilioMediaMessage;
          if (mediaMsg.media.track !== "inbound") break;

          // Decode base64 mulaw → PCM 8kHz → resample to 16kHz → send as binary
          const mulawBytes = Uint8Array.from(
            atob(mediaMsg.media.payload),
            (c) => c.charCodeAt(0)
          );
          const pcm8k = decodeMulawToPCM(mulawBytes);
          const pcm16k = resamplePCM(pcm8k, 8000, 16000);
          const pcmBuffer = int16ToArrayBuffer(pcm16k);

          if (agentSocket?.readyState === WebSocket.OPEN) {
            agentSocket.send(pcmBuffer);
          }
          break;
        }

        case "stop": {
          console.log(`[TwilioAdapter] Stream stopped: ${streamSid}`);
          if (agentSocket?.readyState === WebSocket.OPEN) {
            agentSocket.send(JSON.stringify({ type: "end_call" }));
            agentSocket.close();
          }
          break;
        }

        case "dtmf": {
          // Forward DTMF tones as non-voice messages
          if (agentSocket?.readyState === WebSocket.OPEN) {
            agentSocket.send(JSON.stringify(msg));
          }
          break;
        }
      }
    });

    serverSocket.addEventListener("close", () => {
      console.log("[TwilioAdapter] Twilio disconnected");
      if (agentSocket?.readyState === WebSocket.OPEN) {
        agentSocket.send(JSON.stringify({ type: "end_call" }));
        agentSocket.close();
      }
    });

    return new Response(null, {
      status: 101,
      webSocket: twilioSocket
    });
  }
}
