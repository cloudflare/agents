import {
  AssemblyAISTT,
  type AssemblyAIMode,
  type AssemblyAILanguageCode,
  type AssemblyAIVoiceFocus
} from "@cloudflare/voice-assemblyai";
import type { Transcriber } from "@cloudflare/voice";
import { getEnvString, getProviderKeyterms } from "./utils";

const ASSEMBLYAI_PROMPT =
  "A helpful Cloudflare voice assistant. Users may ask about Cloudflare Workers, Durable Objects, Workers AI, voice agents, reminders, dates, times, and weather.";

export function createAssemblyAITranscriber(env: Env, url: URL): Transcriber {
  const apiKey = getEnvString(env, "ASSEMBLYAI_API_KEY");
  if (!apiKey) throw new Error("ASSEMBLYAI_API_KEY is not configured.");
  const mode = url.searchParams.get("assemblyaiMode");
  const voiceFocus = url.searchParams.get("voiceFocus");

  return new AssemblyAISTT({
    apiKey,
    mode: isAssemblyAIMode(mode) ? mode : "balanced",
    prompt: url.searchParams.get("prompt") || ASSEMBLYAI_PROMPT,
    keyterms: getProviderKeyterms(url),
    languageCodes: getAssemblyAILanguageCodes(url),
    voiceFocus: isAssemblyAIVoiceFocus(voiceFocus) ? voiceFocus : undefined
  });
}

function getAssemblyAILanguageCodes(
  url: URL
): AssemblyAILanguageCode[] | undefined {
  const configured = url.searchParams
    .get("assemblyaiLanguageCodes")
    ?.split(",")
    .map((code) => code.trim())
    .filter((code) => code.length > 0) as AssemblyAILanguageCode[] | undefined;
  return configured && configured.length > 0 ? configured : undefined;
}

function isAssemblyAIMode(value: string | null): value is AssemblyAIMode {
  return (
    value === "min_latency" || value === "balanced" || value === "max_accuracy"
  );
}

function isAssemblyAIVoiceFocus(
  value: string | null
): value is AssemblyAIVoiceFocus {
  return value === "near-field" || value === "far-field";
}
