/**
 * OpenAI Responses wire: pi-ai's own Responses converters and stream
 * processor, over AI Gateway's universal endpoint.
 *
 * Only the transport differs from talking to OpenAI directly: the body goes to
 * the gateway, which forwards it to `api.openai.com/v1/responses` with the key
 * it holds, and the raw SSE `Response` comes back. The model object is passed
 * through untouched, so the encrypted reasoning items pi replays on a later
 * turn are recognised as the same model's.
 */

import {
  type AssistantMessageEventStream,
  type Model,
  createAssistantMessageEventStream
} from "@earendil-works/pi-ai";
import {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream
} from "@earendil-works/pi-ai/api/openai-responses-shared";
import { clampOpenAIPromptCacheKey } from "@earendil-works/pi-ai/api/openai-prompt-cache";
import type { Transport } from "../../core/transport";
import { wireModelId } from "../catalog";
import { assertOk, failStream } from "../errors";
import {
  MIN_OUTPUT_TOKENS,
  attachCorrelation,
  correlationDetails,
  openAIVendorHeaders,
  responseInfo,
  sendUniversal,
  sseJson,
  startMessage,
  withIdleDeadline,
  ignoredWorkersAIKnobs,
  recordWarnings
} from "./shared";
import type { WireRequest } from "../settings";

/**
 * Providers whose tool-call ids carry OpenAI `call|item` pairing across
 * turns. This provider sanitizes ids instead, like pi-ai's own gateway
 * provider, so the set is empty.
 */
const TOOL_CALL_ID_PROVIDERS: ReadonlySet<string> = new Set();

const TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed"
]);

/** A level through the model's own map, or the level's own name. */
function mappedEffort(model: Model<string>, effort: string): string {
  const map = model.thinkingLevelMap as
    | Record<string, string | null | undefined>
    | undefined;
  return map?.[effort] ?? effort;
}

/** Streams a Responses request and maps it onto pi-ai events. */
export function streamResponses(
  request: WireRequest,
  transport: Transport
): AssistantMessageEventStream {
  const { model, context, options, resolved } = request;
  const stream = createAssistantMessageEventStream();
  const output = startMessage(model);
  const observed = { endedCleanly: false, sawTerminalEvent: false };

  void (async () => {
    let response: Response | undefined;
    try {
      const responsesModel = model as Model<"openai-responses">;
      const body: Record<string, unknown> = {
        input: convertResponsesMessages(
          responsesModel,
          context,
          TOOL_CALL_ID_PROVIDERS
        ),
        // The universal request carries the vendor's own spelling of the id.
        model: wireModelId(model),
        store: false,
        stream: true
      };
      if (context.tools !== undefined && context.tools.length > 0) {
        body.tools = convertResponsesTools(context.tools);
      }
      if (request.toolChoice !== undefined) {
        body.tool_choice =
          typeof request.toolChoice === "string"
            ? request.toolChoice
            : { name: request.toolChoice.function.name, type: "function" };
      }
      if (options.maxTokens !== undefined) {
        body.max_output_tokens = Math.max(options.maxTokens, MIN_OUTPUT_TOKENS);
      }
      if (options.temperature !== undefined) {
        body.temperature = options.temperature;
      }
      const cacheKey = clampOpenAIPromptCacheKey(
        resolved.sessionAffinity ?? options.sessionId
      );
      if (cacheKey !== undefined) body.prompt_cache_key = cacheKey;
      // The effort a level names is the model's own to decide: its
      // `thinkingLevelMap` maps it, and its `off` entry says whether the model
      // can be asked for no reasoning at all. Both reads mirror pi-ai's own
      // Responses implementation; neither is a rule of this package.
      if (model.reasoning === true) {
        const effort = request.reasoningEffort;
        if (typeof effort === "string") {
          body.reasoning = {
            effort: mappedEffort(model, effort),
            summary: "auto"
          };
          // Encrypted reasoning items keep `store: false` multi-turn replay
          // stateless, mirroring pi-ai's own Responses request shape.
          body.include = ["reasoning.encrypted_content"];
        } else if (model.thinkingLevelMap?.off !== null) {
          body.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
        }
      }
      const sampling = (options as { samplingParams?: Record<string, unknown> })
        .samplingParams;
      if (sampling !== undefined) Object.assign(body, sampling);
      const overridden = await options.onPayload?.(body, model);
      const payload =
        overridden === undefined
          ? body
          : (overridden as Record<string, unknown>);

      response = await sendUniversal(
        request,
        transport,
        payload,
        openAIVendorHeaders()
      );
      await options.onResponse?.(responseInfo(response), model);
      attachCorrelation(
        output,
        correlationDetails(request, response, transport)
      );
      recordWarnings(output, ignoredWorkersAIKnobs(request));
      await assertOk(response, {
        model: model.id,
        requestBodyValues: payload,
        url: transport.url
      });
      if (response.body === null) {
        throw new Error("The model returned an empty response body.");
      }

      stream.push({ partial: output, type: "start" });

      const events = observe(
        sseJson(withIdleDeadline(response.body, request.streamIdleTimeoutMs))
      );
      await processResponsesStream(
        events as Parameters<typeof processResponsesStream>[0],
        output,
        stream,
        responsesModel
      );

      if (options.signal?.aborted) throw new Error("Request was aborted.");
      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error(
          output.errorMessage ?? "The model reported an error stop reason."
        );
      }
      if (observed.endedCleanly && !observed.sawTerminalEvent) {
        throw new Error("The stream ended without a terminal response event.");
      }
      stream.push({
        message: output,
        reason: output.stopReason as "stop" | "length" | "toolUse",
        type: "done"
      });
      stream.end(output);
    } catch (error) {
      if (response?.body !== null && response?.body?.locked === false) {
        void response.body.cancel().catch(() => {});
      }
      for (const block of output.content) {
        delete (block as { index?: number }).index;
        delete (block as { partialJson?: string }).partialJson;
        delete (block as { customInput?: unknown }).customInput;
      }
      failStream(stream, output, error, options.signal);
    }
  })();

  return stream;

  async function* observe(
    events: AsyncIterable<unknown>
  ): AsyncIterable<unknown> {
    for await (const event of events) {
      const type = (event as { type?: unknown } | null)?.type;
      if (typeof type === "string" && TERMINAL_EVENTS.has(type)) {
        observed.sawTerminalEvent = true;
      }
      yield event;
    }
    observed.endedCleanly = true;
  }
}
