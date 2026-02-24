---
"@cloudflare/codemode": patch
"agents": patch
---

Harden JSON Schema to TypeScript converter for production use

- Add depth and circular reference guards to prevent stack overflows on recursive or deeply nested schemas
- Add `$ref` resolution for internal JSON Pointers (`#/definitions/...`, `#/$defs/...`, `#`)
- Add tuple support (`prefixItems` for JSON Schema 2020-12, array `items` for draft-07)
- Add OpenAPI 3.0 `nullable: true` support across all schema branches
- Fix string escaping in enum/const values, property names (control chars, U+2028/U+2029), and JSDoc comments (`*/`)
- Add per-tool error isolation in `generateTypes()` so one malformed schema cannot crash the pipeline
- Guard missing `inputSchema` in `getAITools()` with a fallback to `{ type: "object" }`
- Add per-tool error isolation in `getAITools()` so one bad MCP tool does not break the entire tool set
