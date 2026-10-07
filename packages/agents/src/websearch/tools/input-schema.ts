/**
 * The zod input schema shared by the AI SDK and TanStack AI adapters. Kept
 * out of the core so the pi adapter, which uses TypeBox, does not need zod.
 * Internal — not an entry point.
 */
import { z } from "zod";
import {
  MAX_WEB_SEARCH_QUERY_LENGTH,
  type WebSearchToolInput
} from "../contract";

/**
 * The model's input schema. The description tells the model the host's
 * `limit`; a larger value is not rejected (which would cost a validation
 * round trip) but capped by the core.
 */
export function webSearchInputSchema(maxLimit: number) {
  return z.object({
    query: z
      .string()
      .min(1)
      .max(MAX_WEB_SEARCH_QUERY_LENGTH)
      .describe("What to search for."),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(`How many results to return (at most ${maxLimit}).`)
  }) satisfies z.ZodType<WebSearchToolInput>;
}
