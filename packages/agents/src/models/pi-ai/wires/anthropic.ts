/**
 * Anthropic Messages wire: pi-ai's own Anthropic implementation, over AI
 * Gateway — `/run` for a catalog model, the provider-native path otherwise.
 *
 * Everything about the wire — request shaping, thinking, tool use, stream
 * parsing, thinking-signature replay, error fallbacks — is pi-ai's, on its own
 * Anthropic SDK client. The `fetch` given to that client sends the SDK's
 * request through the gateway instead of to Anthropic.
 *
 * The model object is never rewritten: `api`, `provider` and `id` reach pi's
 * implementation exactly as they will be recorded on the assistant message, so
 * a later turn replaying a thinking block is recognised as the same model.
 */

import {
  type AnthropicEffort,
  type AnthropicOptions,
  type Api,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type ThinkingLevel,
  createAssistantMessageEventStream
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { adjustMaxTokensForThinking } from "@earendil-works/pi-ai/api/simple-options";
import { wireModelId } from "../catalog";
import { failStream } from "../errors";
import { errorFromResponse, type Transport } from "../../core/transport";
import {
  anthropicVendorHeaders,
  attachCorrelation,
  correlationDetails,
  sendGateway,
  startMessage,
  withIdleDeadline,
  ignoredWorkersAIKnobs,
  recordWarnings
} from "./shared";
import type { WireRequest } from "../settings";

/** The key pi-ai's SDK client is built with. The gateway holds the real one. */
const GATEWAY_HELD_KEY = "held-by-ai-gateway";

/**
 * Maps a pi thinking level onto an Anthropic effort the way pi-ai's own
 * `streamSimple` does: the model's `thinkingLevelMap` first, then the level's
 * own name. The map is the model author's; nothing here decides it.
 */
function effortForLevel(
  model: Model<Api>,
  level: ThinkingLevel
): AnthropicEffort {
  const mapped = model.thinkingLevelMap?.[level];
  if (typeof mapped === "string") return mapped as AnthropicEffort;
  switch (level) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    default:
      return "high";
  }
}

/**
 * pi-ai's `streamSimple` thinking rules, applied here because that entry point
 * insists on a credential and this transport has none. Which branch a model
 * takes is the model's own `compat.forceAdaptiveThinking`, not a rule of ours.
 */
function thinkingOptions(
  model: Model<Api>,
  options: SimpleStreamOptions
): Pick<
  AnthropicOptions,
  "thinkingEnabled" | "thinkingBudgetTokens" | "maxTokens" | "effort"
> {
  const level = options.reasoning;
  if (level === undefined || !model.reasoning) {
    return { thinkingEnabled: false };
  }
  const compat = (model as { compat?: { forceAdaptiveThinking?: boolean } })
    .compat;
  if (compat?.forceAdaptiveThinking === true) {
    return { effort: effortForLevel(model, level), thinkingEnabled: true };
  }
  const { maxTokens, thinkingBudget } = adjustMaxTokensForThinking(
    options.maxTokens,
    model.maxTokens,
    level,
    options.thinkingBudgets
  );
  return {
    maxTokens,
    thinkingBudgetTokens: thinkingBudget,
    thinkingEnabled: true
  };
}

/** Streams an Anthropic request through pi-ai's implementation. */
export function streamAnthropic(
  request: WireRequest,
  transport: Transport
): AssistantMessageEventStream {
  const { model, context, options } = request;
  const outer = createAssistantMessageEventStream();
  const placeholder = startMessage(model);
  let correlation: ReturnType<typeof correlationDetails> | undefined;
  // pi-ai's own implementation ends the stream with its own error event for a
  // failed request, which would lose the typed Cloudflare error. Holding it
  // here lets the wire report it instead.
  let transportError: unknown;

  // pi-ai builds its own Anthropic SDK client and sends through this fetch,
  // which routes the SDK's request through the gateway. The SDK turns a
  // vendor's error response into its own `APIError`, which is what pi-ai's
  // fallbacks look for: a thread it can no longer continue is resent in
  // full, and strict tools over Anthropic's limits are sent without strict.
  const fetch = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    // Only the newest request's failure is the stream's: a fallback that
    // resends after one is answered on its own.
    transportError = undefined;
    const sdkRequest = new Request(input, init);
    const { model: _sdkModel, ...vendorParams } =
      (await sdkRequest.json()) as Record<string, unknown>;
    // The body carries the vendor's own spelling of the id, whatever this
    // provider lists the model under; `/run` takes the catalog id instead.
    const body = { ...vendorParams, model: wireModelId(model) };
    // The SDK sends the beta features pi-ai chose as the `anthropic-beta`
    // header. Its other headers, such as its placeholder key, stay behind:
    // the gateway holds the key.
    const betas = sdkRequest.headers.get("anthropic-beta");
    const context = {
      model: model.id,
      requestBodyValues: body,
      url: transport.url
    };
    try {
      const response = await sendGateway(
        request,
        transport,
        body,
        anthropicVendorHeaders(betas ? betas.split(",") : []),
        "messages",
        (raw) => {
          correlation = correlationDetails(request, raw, transport);
        }
      );
      if (!response.ok) {
        // The SDK reads the vendor's error from the response; the typed
        // Cloudflare error is kept in case the stream ends with it.
        transportError = await errorFromResponse(response.clone(), context);
        return response;
      }
      if (response.body === null) return response;
      return new Response(
        withIdleDeadline(response.body, request.streamIdleTimeoutMs),
        response
      );
    } catch (error) {
      transportError = error;
      throw error;
    }
  };

  const anthropicOptions: AnthropicOptions = {
    ...options,
    ...(request.simple ? thinkingOptions(model, options) : {}),
    // pi-ai requires a credential; the gateway holds the real one, and this
    // placeholder never leaves the fetch above.
    apiKey: GATEWAY_HELD_KEY,
    fetch,
    ...(request.toolChoice !== undefined
      ? {
          toolChoice:
            typeof request.toolChoice === "string"
              ? request.toolChoice === "required"
                ? "any"
                : request.toolChoice
              : { name: request.toolChoice.function.name, type: "tool" }
        }
      : {})
  };

  void (async () => {
    try {
      const inner = anthropicMessagesApi().stream(
        model as Model<"anthropic-messages">,
        context,
        anthropicOptions
      );
      for await (const event of inner) {
        // A transport failure is ours to report: pi-ai's own error event knows
        // nothing of the gateway's status, code or log id, so the message it
        // built is re-failed here with that diagnostic attached.
        if (event.type === "error" && transportError !== undefined) {
          failFrom(event.error);
          return;
        }
        if (event.type === "done" || event.type === "error") {
          const message = event.type === "done" ? event.message : event.error;
          if (correlation !== undefined) {
            attachCorrelation(message, correlation);
          }
          recordWarnings(message, ignoredWorkersAIKnobs(request));
        }
        outer.push(event);
      }
      if (transportError !== undefined) {
        failFrom(placeholder);
        return;
      }
      outer.end(await inner.result());
    } catch (error) {
      failStream(outer, placeholder, transportError ?? error, options.signal);
    }
  })();

  /** Ends the stream with the transport's own error, keeping any content. */
  function failFrom(message: typeof placeholder): void {
    if (correlation !== undefined) attachCorrelation(message, correlation);
    failStream(outer, message, transportError, options.signal);
  }

  return outer;
}
