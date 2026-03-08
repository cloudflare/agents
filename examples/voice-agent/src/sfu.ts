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

import {
  extractPayloadFromProtobuf,
  encodePayloadToProtobuf,
  downsample48kStereoTo16kMono,
  upsample16kMonoTo48kStereo,
  createSFUSession,
  addSFUTracks,
  renegotiateSFUSession,
  createSFUWebSocketAdapter
} from "@cloudflare/voice";
import type { SFUConfig } from "@cloudflare/voice";

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
      const result = await createSFUSession(config);
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
      const result = await addSFUTracks(config, body.sessionId, body.tracks);
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
      const result = await renegotiateSFUSession(
        config,
        body.sessionId,
        body.sdp
      );
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
      const result = await createSFUWebSocketAdapter(config, body.tracks);
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
