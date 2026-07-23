import type { Transcriber } from "@cloudflare/voice";
import { ElevenLabsSTT } from "@cloudflare/voice-elevenlabs";
import { getEnvString, getProviderKeyterms, optionalBoolean } from "./utils";

export function createElevenLabsTranscriber(env: Env, url: URL): Transcriber {
  const apiKey = getEnvString(env, "ELEVENLABS_API_KEY");
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not configured.");

  return new ElevenLabsSTT({
    apiKey,
    languageCode: url.searchParams.get("language") ?? undefined,
    keyterms: getProviderKeyterms(url),
    noVerbatim: optionalBoolean(url.searchParams.get("noVerbatim")),
    filterBackgroundAudio: optionalBoolean(
      url.searchParams.get("filterBackgroundAudio")
    )
  });
}
