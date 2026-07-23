import type { SttProvider } from "./types";

export function getWorkersAIQuery(
  provider: SttProvider
): Record<string, string> {
  return { stt: provider };
}

export function getWorkersAIDescription(provider: SttProvider): string {
  if (provider === "workers-ai-nova-3") {
    return "Workers AI Nova 3 is another no-key STT model available through the Workers AI binding.";
  }

  return "Workers AI Flux is the default no-key path with server-side turn detection and interruption support.";
}
