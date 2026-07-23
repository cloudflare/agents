import type { Transcriber } from "@cloudflare/voice";
import type { Connection } from "agents";
import { createAssemblyAITranscriber } from "./stt-providers/assemblyai";
import { createElevenLabsTranscriber } from "./stt-providers/elevenlabs";
import { createTelnyxTranscriber } from "./stt-providers/telnyx";
import type { SttProvider } from "./stt-providers/types";
import { getEnvString } from "./stt-providers/utils";
import { createWorkersAITranscriber } from "./stt-providers/workers-ai";

export function createVoiceTranscriber(
  connection: Connection,
  env: Env
): Transcriber {
  const url = getConnectionUrl(connection);
  const provider = getSttProvider(connection);

  if (provider === "assemblyai") {
    return createAssemblyAITranscriber(env, url);
  }

  if (provider === "telnyx") {
    return createTelnyxTranscriber(env, url);
  }

  if (provider === "elevenlabs") {
    return createElevenLabsTranscriber(env, url);
  }

  return createWorkersAITranscriber(env, provider);
}

export function getMissingSttProviderKey(
  connection: Connection,
  env: Env
): string | null {
  const provider = getSttProvider(connection);
  if (provider === "assemblyai" && !getEnvString(env, "ASSEMBLYAI_API_KEY")) {
    return "AssemblyAI STT requires ASSEMBLYAI_API_KEY in your .env file or Worker secrets.";
  }
  if (provider === "telnyx" && !getEnvString(env, "TELNYX_API_KEY")) {
    return "Telnyx STT requires TELNYX_API_KEY in your .env file or Worker secrets.";
  }
  if (provider === "elevenlabs" && !getEnvString(env, "ELEVENLABS_API_KEY")) {
    return "ElevenLabs STT requires ELEVENLABS_API_KEY in your .env file or Worker secrets.";
  }
  return null;
}

function getConnectionUrl(connection: Connection): URL {
  return new URL(connection.uri ?? "http://localhost");
}

function getSttProvider(connection: Connection): SttProvider {
  const url = getConnectionUrl(connection);
  const provider = url.searchParams.get("stt");

  if (
    provider === "workers-ai-nova-3" ||
    provider === "assemblyai" ||
    provider === "telnyx" ||
    provider === "elevenlabs"
  ) {
    return provider;
  }

  // Preserve the old query parameter so existing links keep working.
  if (url.searchParams.get("model") === "nova-3") {
    return "workers-ai-nova-3";
  }

  return "workers-ai-flux";
}
