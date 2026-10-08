/**
 * The zod input schema shared by the AI SDK and TanStack AI adapters. Kept
 * out of the core so the pi adapter, which uses TypeBox, does not need zod.
 * Internal — not an entry point.
 */
import { z } from "zod";
import { MAX_WEB_FETCH_URL_LENGTH, type WebFetchToolInput } from "../contract";

/** The model's input schema. */
export function webFetchInputSchema() {
  return z.object({
    url: z
      .string()
      .min(1)
      .max(MAX_WEB_FETCH_URL_LENGTH)
      .describe("The http(s) URL to read."),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Character offset into the content, to continue a long page from the previous result's offset. Default 0."
      ),
    format: z
      .enum(["auto", "raw"])
      .optional()
      .describe(
        '"auto" (default) converts to the most readable form; "raw" returns the body as served.'
      )
  }) satisfies z.ZodType<WebFetchToolInput>;
}
