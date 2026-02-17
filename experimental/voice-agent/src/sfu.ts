/**
 * Cloudflare Realtime SFU integration for VoiceAgent.
 *
 * Bridges the SFU WebSocket adapter protocol (48kHz stereo protobuf PCM)
 * to the VoiceAgent protocol (16kHz mono 16-bit PCM binary frames + JSON).
 *
 * Architecture:
 *   Browser → WebRTC → SFU → WebSocket Adapter → this module → VoiceAgent DO
 *
 * The SFU handles WebRTC negotiation, codec transcoding, and network
 * resilience. This module handles audio format conversion and routing.
 */

const SFU_API_BASE = "https://rtc.live.cloudflare.com/v1";

// --- Protobuf helpers ---
// The SFU WebSocket adapter uses a simple protobuf message:
//   message Packet {
//     uint32 sequenceNumber = 1;
//     uint32 timestamp = 2;
//     bytes payload = 5;
//   }

function decodeVarint(
  buf: Uint8Array,
  offset: number
): { value: number; bytesRead: number } {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;
  while (offset + bytesRead < buf.length) {
    const byte = buf[offset + bytesRead];
    value |= (byte & 0x7f) << shift;
    bytesRead++;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value, bytesRead };
}

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7f);
  return new Uint8Array(bytes);
}

/** Extract the PCM payload from a protobuf Packet message. */
function extractPayloadFromProtobuf(data: ArrayBuffer): Uint8Array | null {
  const buf = new Uint8Array(data);
  let offset = 0;

  while (offset < buf.length) {
    const { value: tag, bytesRead: tagBytes } = decodeVarint(buf, offset);
    offset += tagBytes;

    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x07;

    if (wireType === 0) {
      // Varint
      const { bytesRead } = decodeVarint(buf, offset);
      offset += bytesRead;
    } else if (wireType === 2) {
      // Length-delimited (bytes)
      const { value: length, bytesRead: lenBytes } = decodeVarint(buf, offset);
      offset += lenBytes;

      if (fieldNumber === 5) {
        // payload field
        return buf.slice(offset, offset + length);
      }
      offset += length;
    } else {
      // Unknown wire type — skip
      break;
    }
  }

  return null;
}

/** Encode PCM payload into a protobuf Packet message (for ingest/buffer mode — just payload). */
function encodePayloadToProtobuf(payload: Uint8Array): ArrayBuffer {
  // Field 5, wire type 2 (length-delimited): tag = (5 << 3) | 2 = 42
  const tagBytes = encodeVarint(42);
  const lengthBytes = encodeVarint(payload.length);

  const result = new Uint8Array(
    tagBytes.length + lengthBytes.length + payload.length
  );
  result.set(tagBytes, 0);
  result.set(lengthBytes, tagBytes.length);
  result.set(payload, tagBytes.length + lengthBytes.length);

  return result.buffer;
}

// --- Audio conversion ---

/** Downsample 48kHz stereo interleaved PCM to 16kHz mono PCM (both 16-bit LE). */
function downsample48kStereoTo16kMono(stereo48k: Uint8Array): ArrayBuffer {
  // Input: 48kHz stereo 16-bit LE → 2 channels × 2 bytes = 4 bytes per sample pair
  // Output: 16kHz mono 16-bit LE → 2 bytes per sample
  // Ratio: 48000/16000 = 3, plus stereo→mono = average of L+R

  const inputView = new DataView(
    stereo48k.buffer,
    stereo48k.byteOffset,
    stereo48k.byteLength
  );
  const inputSamples = stereo48k.byteLength / 4; // stereo sample pairs
  const outputSamples = Math.floor(inputSamples / 3);
  const output = new ArrayBuffer(outputSamples * 2);
  const outputView = new DataView(output);

  for (let i = 0; i < outputSamples; i++) {
    const srcOffset = i * 3 * 4; // 3x downsample, 4 bytes per stereo pair
    if (srcOffset + 3 >= stereo48k.byteLength) break;
    const left = inputView.getInt16(srcOffset, true);
    const right = inputView.getInt16(srcOffset + 2, true);
    const mono = Math.round((left + right) / 2);
    outputView.setInt16(i * 2, mono, true);
  }

  return output;
}

/** Upsample 16kHz mono PCM to 48kHz stereo interleaved PCM (both 16-bit LE). */
function upsample16kMonoTo48kStereo(mono16k: ArrayBuffer): Uint8Array {
  const inputView = new DataView(mono16k);
  const inputSamples = mono16k.byteLength / 2;
  const outputSamples = inputSamples * 3; // 3x upsample
  const output = new ArrayBuffer(outputSamples * 4); // stereo = 4 bytes per pair
  const outputView = new DataView(output);

  for (let i = 0; i < inputSamples; i++) {
    const sample = inputView.getInt16(i * 2, true);
    // Write 3 stereo samples (simple sample duplication)
    for (let j = 0; j < 3; j++) {
      const outOffset = (i * 3 + j) * 4;
      outputView.setInt16(outOffset, sample, true); // left
      outputView.setInt16(outOffset + 2, sample, true); // right
    }
  }

  return new Uint8Array(output);
}

// --- SFU API helpers ---

interface SFUConfig {
  appId: string;
  apiToken: string;
}

async function sfuFetch(
  config: SFUConfig,
  path: string,
  body: unknown
): Promise<unknown> {
  const url = `${SFU_API_BASE}/apps/${config.appId}${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SFU API error ${response.status}: ${text}`);
  }
  return response.json();
}

async function createSession(config: SFUConfig): Promise<unknown> {
  return sfuFetch(config, "/sessions/new", {});
}

async function addTracks(
  config: SFUConfig,
  sessionId: string,
  body: unknown
): Promise<unknown> {
  return sfuFetch(config, `/sessions/${sessionId}/tracks/new`, body);
}

async function renegotiate(
  config: SFUConfig,
  sessionId: string,
  sdp: string
): Promise<unknown> {
  const url = `${SFU_API_BASE}/apps/${config.appId}/sessions/${sessionId}/renegotiate`;
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      sessionDescription: { type: "answer", sdp }
    })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SFU renegotiate error ${response.status}: ${text}`);
  }
  return response.json();
}

async function createWebSocketAdapter(
  config: SFUConfig,
  tracks: unknown[]
): Promise<unknown> {
  return sfuFetch(config, "/adapters/websocket/new", { tracks });
}

// --- Main SFU handler ---

export interface SFUHandlerOptions {
  /** SFU App ID */
  appId: string;
  /** SFU API Token */
  apiToken: string;
  /** The VoiceAgent DO namespace */
  agentNamespace: DurableObjectNamespace;
  /** Agent instance name */
  agentInstance?: string;
}

/**
 * Handle SFU-related HTTP requests.
 * Routes:
 *   POST /sfu/session    — Create SFU session + WebSocket adapters
 *   POST /sfu/tracks     — Add tracks to session (WebRTC offer/answer)
 *   PUT  /sfu/renegotiate — Renegotiate session
 *   GET  /sfu/audio-in   — WebSocket endpoint for SFU → Worker (user audio)
 *   GET  /sfu/audio-out  — WebSocket endpoint for Worker → SFU (agent audio)
 */
export async function handleSFURequest(
  request: Request,
  options: SFUHandlerOptions
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const config: SFUConfig = {
    appId: options.appId,
    apiToken: options.apiToken
  };

  // Create a new SFU session
  if (path === "/sfu/session" && request.method === "POST") {
    try {
      const result = await createSession(config);
      return Response.json(result);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "SFU error" },
        { status: 500 }
      );
    }
  }

  // Add tracks to an existing session
  if (path === "/sfu/tracks" && request.method === "POST") {
    try {
      const body = (await request.json()) as {
        sessionId: string;
        tracks: unknown;
      };
      const result = await addTracks(config, body.sessionId, body.tracks);
      return Response.json(result);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "SFU error" },
        { status: 500 }
      );
    }
  }

  // Renegotiate a session
  if (path === "/sfu/renegotiate" && request.method === "PUT") {
    try {
      const body = (await request.json()) as {
        sessionId: string;
        sdp: string;
      };
      const result = await renegotiate(config, body.sessionId, body.sdp);
      return Response.json(result);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "SFU error" },
        { status: 500 }
      );
    }
  }

  // Create WebSocket adapter
  if (path === "/sfu/adapter" && request.method === "POST") {
    try {
      const body = (await request.json()) as { tracks: unknown[] };
      const result = await createWebSocketAdapter(config, body.tracks);
      return Response.json(result);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "SFU error" },
        { status: 500 }
      );
    }
  }

  // WebSocket: SFU streams user audio TO us (48kHz stereo PCM)
  // We downsample and forward to the VoiceAgent
  if (path === "/sfu/audio-in") {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const { 0: clientSocket, 1: serverSocket } = new WebSocketPair();
    serverSocket.accept();

    // Connect to the VoiceAgent DO
    const instanceName = options.agentInstance ?? "sfu-session";
    const id = options.agentNamespace.idFromName(instanceName);
    const stub = options.agentNamespace.get(id);

    const agentUrl = new URL(request.url);
    agentUrl.pathname = `/agents/my-voice-agent/${instanceName}`;
    agentUrl.protocol = agentUrl.protocol.replace("http", "ws");

    const agentResp = await stub.fetch(
      new Request(agentUrl.toString(), {
        headers: { Upgrade: "websocket" }
      })
    );

    const agentWs = agentResp.webSocket;
    if (!agentWs) {
      return new Response("Failed to connect to agent", { status: 500 });
    }
    agentWs.accept();

    // Auto-start a call
    agentWs.send(JSON.stringify({ type: "start_call" }));

    // Forward agent JSON messages back through the SFU audio-in socket
    // (the client can listen on this for transcripts)
    agentWs.addEventListener("message", (event) => {
      if (
        typeof event.data === "string" &&
        serverSocket.readyState === WebSocket.OPEN
      ) {
        serverSocket.send(event.data);
      }
      // Binary audio from agent (MP3) — we would need to convert to
      // 48kHz stereo PCM protobuf for SFU. For now, forward as-is
      // and let the client handle playback separately.
      if (
        event.data instanceof ArrayBuffer &&
        serverSocket.readyState === WebSocket.OPEN
      ) {
        serverSocket.send(event.data);
      }
    });

    // Receive 48kHz stereo PCM from SFU, downsample to 16kHz mono, forward to agent
    serverSocket.addEventListener("message", (event) => {
      if (event.data instanceof ArrayBuffer) {
        // Decode protobuf to extract PCM payload
        const payload = extractPayloadFromProtobuf(event.data);
        if (!payload || payload.length === 0) return;

        // Downsample 48kHz stereo → 16kHz mono
        const pcm16k = downsample48kStereoTo16kMono(payload);

        // Forward to agent as binary PCM
        if (agentWs.readyState === WebSocket.OPEN) {
          agentWs.send(pcm16k);
        }
      }

      // Forward text messages (e.g., end_of_speech from client)
      if (typeof event.data === "string") {
        if (agentWs.readyState === WebSocket.OPEN) {
          agentWs.send(event.data);
        }
      }
    });

    serverSocket.addEventListener("close", () => {
      if (agentWs.readyState === WebSocket.OPEN) {
        agentWs.send(JSON.stringify({ type: "end_call" }));
        agentWs.close();
      }
    });

    agentWs.addEventListener("close", () => {
      if (serverSocket.readyState === WebSocket.OPEN) {
        serverSocket.close();
      }
    });

    return new Response(null, { status: 101, webSocket: clientSocket });
  }

  // WebSocket: Worker sends agent audio TO SFU (for ingest adapter)
  if (path === "/sfu/audio-out") {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const { 0: clientSocket, 1: serverSocket } = new WebSocketPair();
    serverSocket.accept();

    // This endpoint receives audio from the agent and converts to
    // 48kHz stereo protobuf PCM for the SFU ingest adapter.
    // For now, this is a placeholder — the agent would need to send
    // raw PCM (not MP3) for this to work properly.
    serverSocket.addEventListener("message", (event) => {
      if (event.data instanceof ArrayBuffer) {
        // Assume input is 16kHz mono PCM → upsample to 48kHz stereo
        const stereo48k = upsample16kMonoTo48kStereo(event.data);
        const protobuf = encodePayloadToProtobuf(stereo48k);
        if (serverSocket.readyState === WebSocket.OPEN) {
          serverSocket.send(protobuf);
        }
      }
    });

    return new Response(null, { status: 101, webSocket: clientSocket });
  }

  return null;
}
