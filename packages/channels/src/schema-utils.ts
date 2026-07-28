import { z } from "zod";
import type { JsonValue } from "./submissions";

/** A string schema that rejects empty and whitespace-only values. */
export const nonEmptyStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, {
    message: "Expected a non-empty string"
  });

/** A recursive schema for values that durable JSON storage preserves. */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);
