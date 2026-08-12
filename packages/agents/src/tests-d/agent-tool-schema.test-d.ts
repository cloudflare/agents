import { valibotSchema } from "@ai-sdk/valibot";
import { jsonSchema, type FlexibleSchema, type InferToolInput } from "ai";
import * as v from "valibot";
import { z } from "zod";
import { agentTool } from "../agent-tools";
import type { ChatCapableAgentClass } from "../agent-tool-types";

const inputSchema = jsonSchema<{ query: string }>({
  type: "object",
  properties: { query: { type: "string" } },
  required: ["query"]
});

const delegated = agentTool(class {} as unknown as ChatCapableAgentClass, {
  description: "Research a topic",
  inputSchema
});

declare const input: InferToolInput<typeof delegated>;
input.query satisfies string;

// @ts-expect-error input is inferred from the supplied flexible schema
input.missing;

const zodDelegated = agentTool(class {} as unknown as ChatCapableAgentClass, {
  description: "Research a topic",
  inputSchema: z.object({ query: z.string() })
});

declare const zodInput: InferToolInput<typeof zodDelegated>;
zodInput.query satisfies string;

// @ts-expect-error existing Zod input inference remains intact
zodInput.missing;

const valibotInputSchema = valibotSchema(
  v.object({ query: v.pipe(v.string(), v.minLength(3)) })
);
const valibotDelegated = agentTool(
  class {} as unknown as ChatCapableAgentClass,
  {
    description: "Research a topic",
    inputSchema: valibotInputSchema
  }
);

declare const valibotInput: InferToolInput<typeof valibotDelegated>;
valibotInput.query satisfies string;

// @ts-expect-error Valibot input inference rejects unknown fields
valibotInput.missing;

const standardInputSchema: FlexibleSchema<{ topic: string }> = {
  "~standard": {
    version: 1 as const,
    vendor: "test",
    types: undefined as unknown as {
      input: { topic: string };
      output: { topic: string };
    },
    validate: (value: unknown) =>
      typeof value === "object" &&
      value !== null &&
      "topic" in value &&
      typeof value.topic === "string"
        ? { value: { topic: value.topic } }
        : { issues: [{ message: "topic is required" }] },
    jsonSchema: {
      input: (_options: { target: string }) => ({
        type: "object",
        properties: { topic: { type: "string" } },
        required: ["topic"]
      }),
      output: (_options: { target: string }) => ({
        type: "object",
        properties: { topic: { type: "string" } },
        required: ["topic"]
      })
    }
  }
};

const standardDelegated = agentTool(
  class {} as unknown as ChatCapableAgentClass,
  {
    description: "Research a topic",
    inputSchema: standardInputSchema
  }
);

declare const standardInput: InferToolInput<typeof standardDelegated>;
standardInput.topic satisfies string;

// @ts-expect-error Standard Schema inference must not make input optional
const _missingStandardInput: typeof standardInput = undefined;
