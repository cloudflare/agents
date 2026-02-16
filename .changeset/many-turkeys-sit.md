---
"agents": patch
---

Fix scheduling schema compatibility with zod v3 and improve schema structure.

- Change `zod/v3` import to `zod` so the package works for users on zod v3 (who don't have the `zod/v3` subpath).
- Replace flat object with optional fields with a `z.discriminatedUnion` on `when.type`. Each scheduling variant now only contains the fields it needs, making the schema cleaner and easier for LLMs to follow.
- Replace `z.coerce.date()` with `z.string()`. Zod v4's `toJSONSchema()` cannot represent `Date`, and the AI SDK routes zod v4 schemas through it directly. Dates are now returned as ISO 8601 strings.
- **Type change:** `Schedule["when"]` is now a discriminated union instead of a flat object with optional fields. `when.date` is `string` instead of `Date`.
