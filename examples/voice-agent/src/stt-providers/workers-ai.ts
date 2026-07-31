import {
  WorkersAIFluxSTT,
  WorkersAINova3STT,
  type Transcriber
} from "@cloudflare/voice";
import { getOptionalProviderKeyterms } from "./utils";

export function createWorkersAITranscriber(
  env: Env,
  model: string,
  url: URL
): Transcriber {
  const keyterms = getOptionalProviderKeyterms(url);

  if (model === "workers-ai-nova-3") {
    return new WorkersAINova3STT(env.AI, { keyterms });
  }

  return new WorkersAIFluxSTT(env.AI, { keyterms });
}
