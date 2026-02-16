---
"agents": patch
---

Fix scheduling schema compatibility with zod v3 and OpenAI strict mode.

- Change `zod/v3` import to `zod` so the package works for users on zod v3 (who don't have the `zod/v3` subpath).
- Replace `z.discriminatedUnion` with a flat object using nullable fields. OpenAI strict structured outputs rejects `oneOf` (produced by discriminated unions), so this removes the need for `providerOptions: { openai: { strictJsonSchema: false } }`.
- Replace `z.coerce.date()` with `z.string().nullable()`. Zod v4's `toJSONSchema()` cannot represent `Date`, and the AI SDK routes zod v4 schemas through it directly. Dates are now returned as ISO 8601 strings.
- **Type change:** `ScheduleSchema["when"]` fields are now `string | null` instead of `Date | undefined`, and all fields use `.nullable()` instead of `.optional()`.
