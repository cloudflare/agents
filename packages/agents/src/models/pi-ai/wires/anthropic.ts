/**
 * Anthropic Messages wire: pi-ai's own Anthropic implementation, over AI
 * Gateway's universal endpoint.
 *
 * Everything about the wire — request shaping, thinking, tool use, stream
 * parsing, thinking-signature replay — is pi-ai's. It accepts a `client` whose
 * `messages.create(...).asResponse()` returns the raw HTTP response; the one
 * built here routes that call through the gateway instead of the Anthropic
 * SDK, and sets the vendor headers the SDK would otherwise have added.
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
import type { Transport } from "../../core/transport";
import { wireModelId } from "../catalog";
import { assertOk, failStream } from "../errors";
import {
  anthropicVendorHeaders,
  attachCorrelation,
  correlationDetails,
  sendUniversal,
  startMessage,
  withIdleDeadline,
  ignoredWorkersAIKnobs,
  recordWarnings
} from "./shared";
import type { WireRequest } from "../settings";

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
  const hasTools = (context.tools?.length ?? 0) > 0;
  let correlation: ReturnType<typeof correlationDetails> | undefined;
  // pi-ai's own implementation catches whatever `asResponse()` throws and ends
  // the stream with its own error event, which would lose the typed
  // Cloudflare error. Holding it here lets the wire report it instead.
  let transportError: unknown;

  const client = {
    messages: {
      create(params: Record<string, unknown>) {
        return {
          async asResponse(): Promise<Response> {
            // The universal request wants the vendor's own spelling of the id
            // in the body, whatever this provider lists the model under.
            const body = { ...params, model: wireModelId(model) };
            try {
              const response = await sendUniversal(
                request,
                transport,
                body,
                anthropicVendorHeaders(model, hasTools, options),
                (raw) => {
                  correlation = correlationDetails(request, raw, transport);
                }
              );
              await assertOk(response, {
                model: model.id,
                requestBodyValues: body,
                url: transport.url
              });
              if (response.body === null) return response;
              return new Response(
                withIdleDeadline(response.body, request.streamIdleTimeoutMs),
                response
              );
            } catch (error) {
              transportError = error;
              throw error;
            }
          }
        };
      }
    }
  } as unknown as NonNullable<AnthropicOptions["client"]>;

  const anthropicOptions: AnthropicOptions = {
    ...options,
    ...(request.simple ? thinkingOptions(model, options) : {}),
    client,
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
