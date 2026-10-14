import { createAI, type CloudflareLanguageModelId } from "agents/models/ai-sdk";
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
 * The repo-standard Workers AI model. Every text route takes
 * `?model=` — a Workers AI id (`@cf/<author>/<model>`), an AI Gateway catalog
 * id (`anthropic/claude-opus-4.8`, `openai/gpt-5.5`), or a dynamic route
 * (`dynamic/<route>`). All of them run on `env.AI.run`.
 */
const DEFAULT_MODEL = "@cf/zai-org/glm-4.7-flash";

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

function modelOf(
  url: URL,
  fallback = DEFAULT_MODEL
): CloudflareLanguageModelId {
  // Validated by `ai()`, which throws a TypeError naming the three id forms
  // for anything else.
  return (url.searchParams.get("model") ??
    fallback) as CloudflareLanguageModelId;
}

/**
 * The model for a modality route. Those are Workers AI only, so `?model=` is a
 * `@cf/` id; the modality methods throw a TypeError for anything else.
 */
function workersAIModelOf(url: URL, fallback: string): `@cf/${string}` {
  return (url.searchParams.get("model") ?? fallback) as `@cf/${string}`;
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
            model: ai(modelOf(url)),
            prompt: promptOf(url, "Say hello in one short sentence.")
          });
          return Response.json({
            text: result.text,
            model: modelOf(url),
            usage: result.usage,
            // Typed observability: the gateway log id, cache status and the
            // model that actually answered, without walking response objects.
            cloudflare: result.providerMetadata?.cloudflare
          });
        }

        case "/stream": {
          const result = streamText({
            model: ai(modelOf(url)),
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
            model: ai(modelOf(url)),
            prompt: promptOf(url, "What is the weather in Lisbon?"),
            tools: { getWeather },
            // Let the model call the tool and then answer with the result.
            stopWhen: isStepCount(3)
          });
          return Response.json({
            text: result.text,
            model: modelOf(url),
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
            model: ai(modelOf(url)),
            prompt: promptOf(url, "One surprising fact about octopuses."),
            output: Output.object({ schema: factSchema })
          });
          return Response.json({
            model: modelOf(url),
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
            model: ai.image(workersAIModelOf(url, IMAGE_MODEL)),
            prompt: promptOf(url, "A cyberpunk lizard, neon, high contrast"),
            providerOptions: { cloudflare: { steps: 4 } }
          });
          return new Response(bodyOf(result.image.uint8Array), {
            headers: { "content-type": result.image.mediaType }
          });
        }

        case "/speech": {
          const result = await generateSpeech({
            model: ai.speech(workersAIModelOf(url, SPEECH_MODEL)),
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
            model: ai.transcription(workersAIModelOf(url, TRANSCRIPTION_MODEL))
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
            model: ai.reranking(workersAIModelOf(url, RERANKING_MODEL)),
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
          // Try the catalog model first; if it fails before producing any
          // output — an unpaid gateway, an upstream outage — the Workers AI
          // leg answers instead. `cloudflare.model` reports which one did.
          const result = await generateText({
            model: ai("anthropic/claude-opus-4.8", {
              fallback: [DEFAULT_MODEL]
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
