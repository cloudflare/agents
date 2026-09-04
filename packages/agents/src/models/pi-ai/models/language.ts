/**
 * The pi-ai language dispatcher: picks the wire from the model's own `api`
 * marker and runs the request through the transport, with client-side fallback
 * across models.
 *
 * The `api` is the model author's declaration, not a guess of ours: Workers AI
 * models carry {@link CLOUDFLARE_AI_API} and run on `env.AI.run`; every other
 * model carries whatever protocol its registry says it speaks, and goes to AI
 * Gateway's universal endpoint.
 */

import {
  type Api,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ProviderStreams,
  type SimpleStreamOptions,
  createAssistantMessageEventStream
} from "@earendil-works/pi-ai";
import { gatewayLayerOf, mergeModelOptions } from "../../core/settings";
import type { Transport } from "../../core/transport";
import {
  CLOUDFLARE_AI_API,
  type PiModelOptions,
  buildGatewayModel,
  buildWorkersAIModel,
  optionsOf,
  withOptions,
  type PiFallbackLeg
} from "../catalog";
import { failStream } from "../errors";
import { type StreamConfig, type WireRequest, buildRequest } from "../settings";
import { streamAnthropic } from "../wires/anthropic";
import { streamCompletions } from "../wires/chat-completions";
import { streamResponses } from "../wires/responses";
import { startMessage } from "../wires/shared";
import { streamWithFallback } from "./fallback";

/** A stream that fails immediately, for a model this provider cannot route. */
function failedStream(
  request: WireRequest,
  error: Error
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  failStream(
    stream,
    startMessage(request.model),
    error,
    request.options.signal
  );
  return stream;
}

function dispatchOne(
  request: WireRequest,
  transport: Transport
): AssistantMessageEventStream {
  switch (request.model.api) {
    case CLOUDFLARE_AI_API:
    case "openai-completions":
      return streamCompletions(request, transport);
    case "anthropic-messages":
      return streamAnthropic(request, transport);
    case "openai-responses":
      return streamResponses(request, transport);
    default:
      return failedStream(
        request,
        new TypeError(
          `agents/models/pi-ai cannot route the "${request.model.api}" API. AI Gateway serves anthropic-messages, openai-responses and openai-completions models; Workers AI models use "${CLOUDFLARE_AI_API}".`
        )
      );
  }
}

/**
 * The options a fallback leg inherits from the chain: the transport bag, and
 * nothing that describes a model.
 *
 * `name`, `cost`, `contextWindow`, `maxTokens`, `reasoning` and `input` were
 * written about the model they were written on — a leg has its own, from pi's
 * registry — and inheriting them bills the leg's answer at the primary's
 * prices. The leg's own `fallback` is dropped for the same reason `ai()`
 * expands a chain once: a leg is already part of one.
 */
function legOptions(
  options: PiModelOptions | undefined
): PiModelOptions | undefined {
  if (options === undefined) return undefined;
  const {
    fallback: _fallback,
    name: _name,
    cost: _cost,
    contextWindow: _contextWindow,
    maxTokens: _maxTokens,
    reasoning: _reasoning,
    input: _input,
    ...rest
  } = options;
  return rest;
}

/** A leg may be given as a Workers AI id or as a model of any kind. */
function legModel(
  leg: string | Model<Api>,
  options: PiModelOptions | undefined
): Model<Api> {
  // An id has no options of its own, so it takes the chain's transport bag.
  // It resolves exactly as `ai(string)` does: a Workers AI id, or a
  // `<slug>/<id>` pi-ai's gateway registry knows — never a raw vendor id.
  if (typeof leg === "string") {
    return leg.startsWith("@cf/")
      ? buildWorkersAIModel(leg, options)
      : buildGatewayModel(leg, options);
  }
  // A configured leg keeps everything it was built with; the chain's gateway
  // options are layered over its own, field by field, so a chain and its legs
  // travel through one gateway — the same rule the AI SDK module applies.
  const own = optionsOf(leg);
  const inherited = gatewayLayerOf(options);
  const merged = mergeModelOptions<PiFallbackLeg>(
    own,
    Object.keys(inherited).length > 0 ? inherited : undefined
  ) as PiModelOptions | undefined;
  return withOptions(leg, merged);
}

/**
 * Builds pi-ai's `stream` and `streamSimple` for one provider instance. Any
 * model reaches them — this provider's own, or one the caller built from their
 * registry and handed to `ai(model)` — and dispatches on its `api`.
 */
export function createStreams(config: StreamConfig): ProviderStreams {
  const run = (
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions | undefined,
    simple: boolean
  ): AssistantMessageEventStream => {
    const callOptions = options ?? {};
    const primary = buildRequest(model, context, callOptions, simple, config);
    if (primary.fallback.length === 0) {
      return dispatchOne(primary, config.transport);
    }

    const shared = legOptions(optionsOf(model));
    const legs = [
      {
        modelId: model.id,
        start: () => dispatchOne(primary, config.transport)
      },
      ...primary.fallback.map((leg) => {
        const legTarget = legModel(leg, shared);
        return {
          modelId: legTarget.id,
          start: () =>
            dispatchOne(
              buildRequest(legTarget, context, callOptions, simple, config),
              config.transport
            )
        };
      })
    ];
    return streamWithFallback(legs);
  };

  return {
    stream: (model, context, options) =>
      run(model, context, options as SimpleStreamOptions | undefined, false),
    streamSimple: (model, context, options) =>
      run(model, context, options, true)
  };
}
