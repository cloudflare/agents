import type { Transcriber } from "@cloudflare/voice";
import { TelnyxSTT } from "@cloudflare/voice-telnyx/stt";
import { getEnvString } from "./utils";

export function createTelnyxTranscriber(env: Env, url: URL): Transcriber {
  const apiKey = getEnvString(env, "TELNYX_API_KEY");
  if (!apiKey) throw new Error("TELNYX_API_KEY is not configured.");
  const engine = url.searchParams.get("telnyxEngine");
  const telnyxEngine = engine === "Deepgram" ? "Deepgram" : "Telnyx";

  return new TelnyxSTT({
    apiKey,
    engine: telnyxEngine,
    language: url.searchParams.get("language") ?? "en",
    transcriptionModel:
      telnyxEngine === "Deepgram"
        ? (url.searchParams.get("telnyxModel") ?? "flux")
        : undefined
  });
}
