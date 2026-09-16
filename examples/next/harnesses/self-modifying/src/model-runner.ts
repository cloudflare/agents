import type { LanguageModelV4 } from "@ai-sdk/provider";
import { generateText, jsonSchema, tool } from "ai";
import type { ModelMessage, ToolSet } from "ai";
import type { JsonObject } from "./json";
import { toJsonValue } from "./json";
import type {
  HarnessInferenceResult,
  HarnessModelRequest
} from "./runtime-types";

function inputSchema(schema: JsonObject) {
  // SAFETY: The host bridge parses the editable harness value into a JSON
  // object before it reaches this adapter. AI SDK accepts that standard JSON
  // Schema shape, but its upstream JSONSchema7 type is not exported here.
  return jsonSchema(schema as Parameters<typeof jsonSchema>[0]);
}

function modelMessages(request: HarnessModelRequest): ModelMessage[] {
  return request.messages.map((message) => ({
    role: message.role,
    content: message.content
  }));
}

/** Run one trusted model round against an AI SDK Language Model V4 provider. */
export async function runModelRound(
  model: LanguageModelV4,
  request: HarnessModelRequest
): Promise<HarnessInferenceResult> {
  const tools: ToolSet = {};
  for (const definition of request.tools) {
    tools[definition.name] = tool({
      description: definition.description,
      inputSchema: inputSchema(definition.inputSchema)
    });
  }

  const result = await generateText({
    model,
    instructions: request.system,
    messages: modelMessages(request),
    tools,
    maxRetries: 0
  });

  return {
    text: result.text,
    finishReason: result.finishReason,
    toolCalls: result.toolCalls.map((call) => ({
      callId: call.toolCallId,
      name: call.toolName,
      input: toJsonValue(call.input)
    }))
  };
}
