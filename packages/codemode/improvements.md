# Codemode Schema Converter — Known Limitations & Future Improvements

Found during stress-testing with 51 real-world MCP server schemas and adversarial inputs.

## Known Limitations (cannot fix in converter)

### `__proto__` property names are silently dropped

JavaScript object literals treat `__proto__` as a prototype setter, not a regular property. A schema with `properties: { "__proto__": { type: "string" } }` will have the key consumed by the JS engine before our code ever sees it. This affects any JSON Schema that uses `__proto__` as a property name and is constructed via object literals rather than `JSON.parse()`.

**Workaround:** Schemas arriving via `JSON.parse()` (e.g., from MCP server wire protocol) are not affected — `JSON.parse` creates regular properties. Only hand-constructed object literals in JS/TS code hit this.

## Out of Scope (by design)

These are explicitly not supported and fall through to `unknown`:

- **External `$ref` URLs** (e.g., `https://example.com/schema.json`) — security risk, would require fetching
- **`not`, `if/then/else`** — no clean TypeScript equivalent
- **`format` keyword** — `string` with `format: "email"` is still `string` in TS
- **`patternProperties`** — rare, complex, falls through to `additionalProperties`
- **`dependencies` / `dependentRequired`** — conditional requirements can't be expressed in TS types
