import {
  WorkersAIFluxSTT,
  WorkersAINova3STT,
  type Transcriber
} from "@cloudflare/voice";

export function createWorkersAITranscriber(
  env: Env,
  model: string
): Transcriber {
  if (model === "workers-ai-nova-3") {
    return new WorkersAINova3STT(env.AI);
  }

  return new WorkersAIFluxSTT(env.AI);
}
