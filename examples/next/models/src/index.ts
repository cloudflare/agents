import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { createAI, type WorkersAIModelId } from "agents/models/ai-sdk";
import { handlePi } from "./pi";
import {
  embedMany,
  generateImage,
  generateSpeech,
  generateText,
  isStepCount,
  Output,
  rerank,
  streamText,
  tool,
  transcribe
} from "ai";
import { z } from "zod";

/**
 * The repo-standard Workers AI model. Every route takes either
 * `?model=@cf/<author>/<model>` — a Workers AI id, the one catalog this
 * package keeps up with — or `?vendor=anthropic:claude-opus-4-8` /
 * `?vendor=openai:gpt-5-mini`, which builds the model with that vendor's own
 * provider package and routes it through AI Gateway.
 */
const DEFAULT_MODEL = "@cf/zai-org/glm-4.7-flash";

/**
 * The gateway holds the real credential (unified billing, or a BYOK key), so
 * the vendor providers are constructed with a placeholder.
 */
const anthropic = createAnthropic({ apiKey: "cloudflare" });
const openai = createOpenAI({ apiKey: "cloudflare" });

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

/** One default per modality; `?model=` overrides each of them too. */
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const SPEECH_MODEL = "@cf/deepgram/aura-1";
const TRANSCRIPTION_MODEL = "@cf/openai/whisper-large-v3-turbo";
const RERANKING_MODEL = "@cf/baai/bge-reranker-base";

/** The one tool `/tools` offers, so a step loop has something to call. */
const getWeather = tool({
  description: "Get the current weather for a city.",
  inputSchema: z.object({
    city: z.string().describe("City name, e.g. 'Lisbon'")
  }),
  execute: ({ city }) => ({
    city,
    conditions: "clear",
    temperatureC: 21
  })
});

/** The shape `/json` asks the model to fill in. */
const factSchema = z.object({
  fact: z.string(),
  confidence: z.number().min(0).max(1)
});

function modelOf(url: URL, fallback = DEFAULT_MODEL): WorkersAIModelId {
  // Validated by `ai()`, which throws a TypeError naming the fix for anything
  // that is not a `@cf/` id.
  return (url.searchParams.get("model") ?? fallback) as WorkersAIModelId;
}

/**
 * `?vendor=<slug>:<id>` builds a third-party model with its own provider. A
 * vendor id is never a string this provider accepts: only its own package
 * knows that catalog.
 */
function vendorOf(url: URL): LanguageModelV4 | undefined {
  const spec = url.searchParams.get("vendor");
  if (spec === null) return undefined;
  const separator = spec.indexOf(":");
  const slug = separator === -1 ? spec : spec.slice(0, separator);
  const id = separator === -1 ? "" : spec.slice(separator + 1);
  if (slug === "anthropic") return anthropic(id || "claude-opus-4-8");
  if (slug === "openai") return openai.responses(id || "gpt-5-mini");
  throw new Error(
    `Unknown vendor "${slug}". Use vendor=anthropic:<id> or vendor=openai:<id>.`
  );
}

/** What the response reports as the model, on either form. */
function labelOf(url: URL): string {
  return url.searchParams.get("vendor") ?? modelOf(url);
}

/**
 * The model for a text route: the vendor's own object when `?vendor=` is set,
 * a Workers AI id otherwise. Both come back as one `LanguageModelV4`.
 */
function pick(ai: ReturnType<typeof createAI>, url: URL): LanguageModelV4 {
  const vendor = vendorOf(url);
  return vendor === undefined ? ai(modelOf(url)) : ai(vendor);
}

function promptOf(url: URL, fallback: string): string {
  return url.searchParams.get("prompt") ?? fallback;
}

/**
 * `Response` takes bytes backed by an `ArrayBuffer`; the AI SDK types its
 * generated files as `Uint8Array<ArrayBufferLike>`, which TypeScript will not
 * narrow on its own. Copying into a fresh view is the one-line fix.
 */
function bodyOf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // The pi-ai twin of every route below lives under `/pi/*`.
    if (url.pathname === "/pi" || url.pathname.startsWith("/pi/")) {
      return handlePi(url, env);
    }

    // One provider over the whole catalog. Inside a Worker the binding is
    // keyless; `gateway` here is a provider-wide default that per-model and
    // per-call options override.
    const ai = createAI({
      binding: env.AI,
      gateway: { id: "default", metadata: { app: "next-models" } }
    });

    try {
      switch (url.pathname) {
        case "/": {
          const result = await generateText({
            model: pick(ai, url),
            prompt: promptOf(url, "Say hello in one short sentence.")
          });
          return Response.json({
            text: result.text,
            model: labelOf(url),
            usage: result.usage,
            // Typed observability: the gateway log id, cache status and the
            // model that actually answered, without walking response objects.
            cloudflare: result.providerMetadata?.cloudflare
          });
        }

        case "/stream": {
          const result = streamText({
            model: pick(ai, url),
            // A failure raised before the stream starts cannot reach the
            // response body, which is already a 200; log it so the reason for
            // an empty stream is visible in `wrangler dev`.
            onError: ({ error }) => console.error("stream failed", error),
            prompt: promptOf(url, "Write two sentences about Durable Objects.")
          });
          return result.toTextStreamResponse();
        }

        case "/tools": {
          const result = await generateText({
            model: pick(ai, url),
            prompt: promptOf(url, "What is the weather in Lisbon?"),
            tools: { getWeather },
            // Let the model call the tool and then answer with the result.
            stopWhen: isStepCount(3)
          });
          return Response.json({
            text: result.text,
            model: labelOf(url),
            steps: result.steps.map((step) => ({
              text: step.text,
              toolCalls: step.toolCalls.map((call) => ({
                toolName: call.toolName,
                input: call.input
              })),
              toolResults: step.toolResults.map((toolResult) => ({
                toolName: toolResult.toolName,
                output: toolResult.output
              }))
            }))
          });
        }

        case "/json": {
          const result = await generateText({
            model: pick(ai, url),
            prompt: promptOf(url, "One surprising fact about octopuses."),
            output: Output.object({ schema: factSchema })
          });
          return Response.json({
            model: labelOf(url),
            object: result.output,
            cloudflare: result.providerMetadata?.cloudflare
          });
        }

        case "/embed": {
          const values = url.searchParams.getAll("text");
          const result = await embedMany({
            model: ai.embedding(EMBEDDING_MODEL),
            values: values.length > 0 ? values : ["hello", "world"]
          });
          return Response.json({
            model: EMBEDDING_MODEL,
            count: result.embeddings.length,
            dimensions: result.embeddings[0]?.length ?? 0,
            first3: result.embeddings.map((embedding) => embedding.slice(0, 3)),
            usage: result.usage
          });
        }

        case "/image": {
          // The answer is a PNG for the diffusion models and a base64 JPEG
          // for flux; `GeneratedFile` hides the difference either way.
          const result = await generateImage({
            model: ai.image(modelOf(url, IMAGE_MODEL)),
            prompt: promptOf(url, "A cyberpunk lizard, neon, high contrast"),
            providerOptions: { cloudflare: { steps: 4 } }
          });
          return new Response(bodyOf(result.image.uint8Array), {
            headers: { "content-type": result.image.mediaType }
          });
        }

        case "/speech": {
          const result = await generateSpeech({
            model: ai.speech(modelOf(url, SPEECH_MODEL)),
            text: url.searchParams.get("text") ?? "Hello from Cloudflare.",
            ...(url.searchParams.get("voice") === null
              ? {}
              : { voice: url.searchParams.get("voice") as string })
          });
          return new Response(bodyOf(result.audio.uint8Array), {
            headers: { "content-type": result.audio.mediaType }
          });
        }

        case "/transcribe": {
          // POST the audio, or GET and the Worker speaks a line first so the
          // route is curl-able without a file to hand.
          const audio =
            request.method === "POST"
              ? new Uint8Array(await request.arrayBuffer())
              : (
                  await generateSpeech({
                    model: ai.speech(SPEECH_MODEL),
                    text:
                      url.searchParams.get("text") ?? "Hello from Cloudflare."
                  })
                ).audio.uint8Array;
          const result = await transcribe({
            audio,
            model: ai.transcription(modelOf(url, TRANSCRIPTION_MODEL))
          });
          return Response.json({
            durationInSeconds: result.durationInSeconds,
            language: result.language,
            segments: result.segments,
            text: result.text
          });
        }

        case "/rerank": {
          const documents = url.searchParams.getAll("doc");
          const result = await rerank({
            documents:
              documents.length > 0
                ? documents
                : ["a cyberpunk lizard", "a rainy Tuesday", "a cyberpunk cat"],
            model: ai.reranking(modelOf(url, RERANKING_MODEL)),
            query: url.searchParams.get("query") ?? "Which one is cooler?"
          });
          return Response.json({
            ranking: result.ranking.map((row) => ({
              document: row.document,
              index: row.originalIndex,
              score: row.score
            })),
            top: result.rerankedDocuments[0]
          });
        }

        case "/fallback": {
          // Try the vendor model first; if it fails before producing any
          // output — no BYOK key, an unpaid gateway — the Workers AI leg
          // answers instead. `cloudflare.model` reports which one did.
          const result = await generateText({
            model: ai(anthropic("claude-opus-4-8"), {
              fallback: [ai(DEFAULT_MODEL)]
            }),
            prompt: promptOf(url, "Say hello in one short sentence.")
          });
          return Response.json({
            text: result.text,
            usage: result.usage,
            cloudflare: result.providerMetadata?.cloudflare
          });
        }

        default:
          return new Response("Not found", { status: 404 });
      }
    } catch (error) {
      // CloudflareAIError carries `status`, `code`, `model`, `logId` and, for a
      // failed fallback chain, every leg it tried under `attempts`.
      return Response.json(
        {
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error ? { name: error.name } : {})
        },
        { status: 500 }
      );
    }
  }
} satisfies ExportedHandler<Env>;
