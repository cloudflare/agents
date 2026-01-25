import { createWorkersAI } from "workers-ai-provider";
import { openai } from "@ai-sdk/openai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { env } from "cloudflare:workers";

export const model: LanguageModelV3 = (() => {
  if (env.OPENAI_API_KEY) {
    return openai("gpt-4");
  } else {
    const workersai = createWorkersAI({ binding: env.AI });
    return workersai("@cf/meta/llama-2-7b-chat-int8");
  }
})();
