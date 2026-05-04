/**
 * Factory helper that wires up JWT auth + TelnyxCallBridge
 * into a ready-to-use VoiceClient configuration.
 *
 * Usage:
 * ```typescript
 * import { createTelnyxVoiceConfig } from "@cloudflare/voice-telnyx";
 * import { VoiceClient } from "@cloudflare/voice/client";
 *
 * const telnyx = await createTelnyxVoiceConfig({
 *   jwtEndpoint: "/api/telnyx-token",
 *   autoAnswer: true,
 * });
 *
 * const voiceClient = new VoiceClient({
 *   agent: "my-agent",
 *   audioInput: telnyx.audioInput,
 * });
 *
 * // Inject agent audio back into the phone call:
 * voiceClient.on("audio", (pcm) => telnyx.bridge.playAudio(pcm));
 *
 * // On disconnect, clean up server-side credential:
 * await telnyx.cleanup();
 * ```
 */

import {
  TelnyxCallBridge,
  type TelnyxCallBridgeConfig
} from "../providers/call-bridge.js";

export interface TelnyxVoiceConfigOptions {
  /** URL of the JWT endpoint (the TelnyxJWTEndpoint handler). */
  jwtEndpoint: string;
  /** Automatically answer inbound calls. @default false */
  autoAnswer?: boolean;
  /** Enable Telnyx SDK debug logging. @default false */
  debug?: boolean;
}

export interface TelnyxVoiceSetup {
  /** The TelnyxCallBridge instance — use for playAudio(), dial(), hangup(), etc. */
  bridge: TelnyxCallBridge;
  /** Pass this to VoiceClientOptions.audioInput. Same as `bridge`. */
  audioInput: TelnyxCallBridge;
  /** The server-side credential ID (for manual cleanup if needed). */
  credentialId: string;
  /** The SIP username (e.g. "genCredXYZ123") — call this to reach the agent. */
  sipUsername: string;
  /** Stop the bridge and revoke the server-side credential. */
  cleanup: () => Promise<void>;
}

/**
 * Fetch a JWT from the server, create a TelnyxCallBridge, and return
 * everything needed to configure a VoiceClient for phone calls.
 */
export async function createTelnyxVoiceConfig(
  options: TelnyxVoiceConfigOptions
): Promise<TelnyxVoiceSetup> {
  // Fetch JWT from the server-side endpoint
  const response = await fetch(options.jwtEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch JWT: ${response.status}`);
  }

  const body = (await response.json()) as {
    token?: string;
    credentialId?: string;
    sipUsername?: string;
  };

  if (!body.token) {
    throw new Error("JWT response missing token");
  }

  const credentialId = body.credentialId ?? "";
  const sipUsername = body.sipUsername ?? "";

  // Create the bridge with the fetched token
  const bridgeConfig: TelnyxCallBridgeConfig = {
    loginToken: body.token,
    autoAnswer: options.autoAnswer,
    debug: options.debug
  };

  const bridge = new TelnyxCallBridge(bridgeConfig);

  // Cleanup function: stop the bridge + revoke the server-side credential
  const cleanup = async (): Promise<void> => {
    bridge.stop();
    if (credentialId) {
      await fetch(options.jwtEndpoint, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentialId })
      });
    }
  };

  return {
    bridge,
    audioInput: bridge,
    credentialId,
    sipUsername,
    cleanup
  };
}
