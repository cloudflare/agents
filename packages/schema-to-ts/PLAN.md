# schema-to-ts Library Plan

A library that converts both real Zod schemas AND AI SDK `jsonSchema()` wrappers to TypeScript types.

## Goal

Use `jsonSchema()` for performance (100-700x faster than `fromJSONSchema()`) while still supporting TypeScript type generation for codemode.

## Architecture

```
Input Schema
     │
     ├─── Has _zod property? ───► Real Zod Schema ───► zod-to-ts path
     │
     └─── No _zod property? ───► JSON Schema wrapper ───► Direct JSON Schema to TS
```

Both paths produce TypeScript type strings.

---

## Phase 1: Project Setup ✅

- [x] **1.1** Create package.json with dependencies (typescript, zod, ai)
- [x] **1.2** Create tsconfig.json
- [x] **1.3** Create vitest.config.ts
- [x] **1.4** Create src/index.ts entry point
- [x] **1.5** Create src/types.ts with core type definitions

---

## Phase 2: Schema Detection ✅

- [x] **2.1** Create `isZodSchema(schema)` - detects real Zod schemas (v3: `_def`, v4: `_zod`)
- [x] **2.2** Create `isJsonSchemaWrapper(schema)` - detects AI SDK jsonSchema() wrappers
- [x] **2.3** Create `extractJsonSchema(schema)` - extracts raw JSON Schema from either type
- [x] **2.4** Write tests for detection functions (21 tests passing)

---

## Phase 3: JSON Schema to TypeScript Core (IN PROGRESS)

### 3.1 Primitive Types ✅

- [x] **3.1.1** `string` → `string`
- [x] **3.1.2** `number` → `number`
- [x] **3.1.3** `integer` → `number`
- [x] **3.1.4** `boolean` → `boolean`
- [x] **3.1.5** `null` → `null`
- [x] **3.1.6** No type specified → `unknown`
- [x] **3.1.7** Write tests for all primitive types (23 tests)

### 3.2 Literal Types ✅

- [x] **3.2.1** `const` → literal type (`"foo"` → `"foo"`)
- [x] **3.2.2** `enum` with strings → union of string literals
- [x] **3.2.3** `enum` with numbers → union of number literals
- [x] **3.2.4** `enum` with mixed types → union of mixed literals
- [x] **3.2.5** `enum` with null → includes `null` in union
- [x] **3.2.6** Write tests for literal types

### 3.3 String Formats (annotation only, all map to `string`)

- [x] **3.3.1** `format: "date-time"` → `string`
- [x] **3.3.2** `format: "date"` → `string`
- [ ] **3.3.3-3.3.12** Other formats (all map to string, tested via 3.3.1-2)

### 3.4 Object Types ✅

- [x] **3.4.1** `type: "object"` with `properties` → interface/object type
- [x] **3.4.2** Handle `required` array → non-optional properties
- [x] **3.4.3** Properties not in `required` → optional (`?:`)
- [x] **3.4.4** `additionalProperties: false` → exact object
- [x] **3.4.5** `additionalProperties: true` → `& { [key: string]: unknown }`
- [x] **3.4.6** `additionalProperties: <schema>` → `& { [key: string]: T }`
- [x] **3.4.7** Empty object `{}` → `Record<string, unknown>`
- [ ] **3.4.8** `patternProperties` → index signature with union
- [ ] **3.4.9** `propertyNames` → constrain index signature key type
- [x] **3.4.10** Nested objects → recursive conversion
- [x] **3.4.11** Write tests for object types (15 tests)

### 3.5 Array Types ✅

- [x] **3.5.1** `type: "array"` with `items` schema → `T[]`
- [x] **3.5.2** `items` as array (tuple) → `[T1, T2, ...]`
- [x] **3.5.3** `prefixItems` (JSON Schema 2020-12) → tuple types
- [x] **3.5.4** `prefixItems` + `items` → tuple with rest `[T1, T2, ...T3[]]`
- [ ] **3.5.5** `minItems` + `maxItems` equal → fixed length tuple
- [x] **3.5.6** No `items` → `unknown[]`
- [x] **3.5.7** Write tests for array types (12 tests)

### 3.6 Union Types (anyOf) ✅

- [x] **3.6.1** `anyOf` with schemas → `T1 | T2 | T3`
- [ ] **3.6.2** Flatten nested `anyOf`
- [x] **3.6.3** Deduplicate identical types in union
- [x] **3.6.4** `anyOf` with single item → unwrap
- [x] **3.6.5** Write tests for anyOf

### 3.7 Intersection Types (allOf) ✅

- [x] **3.7.1** `allOf` with schemas → `T1 & T2 & T3`
- [ ] **3.7.2** Flatten nested `allOf`
- [x] **3.7.3** `allOf` with single item → unwrap
- [x] **3.7.4** `allOf` with objects → merge properties
- [x] **3.7.5** Write tests for allOf

### 3.8 Exclusive Union (oneOf) ✅

- [x] **3.8.1** `oneOf` with schemas → `T1 | T2 | T3` (same as anyOf for types)
- [ ] **3.8.2** Discriminated unions detection
- [x] **3.8.3** Write tests for oneOf

### 3.9 Negation (not) ✅

- [x] **3.9.1** `not` → typically `unknown` (hard to represent in TS)
- [ ] **3.9.2** `not: { type: "null" }` → exclude null from union
- [x] **3.9.3** Write tests for not

### 3.10 Conditional (if/then/else) ✅

- [x] **3.10.1** `if/then/else` → union of then and else types
- [x] **3.10.2** `if/then` without else → union with base
- [x] **3.10.3** Write tests for conditionals

### 3.11 References ✅

- [x] **3.11.1** `$ref` to `#/$defs/Name` → reference type by name
- [x] **3.11.2** `$defs` definitions → generate named types
- [x] **3.11.3** Circular `$ref` → handle with type aliases
- [x] **3.11.4** External `$ref` (URLs) → `unknown` or error
- [ ] **3.11.5** `$dynamicRef` → same as `$ref` for types
- [x] **3.11.6** Write tests for references (5 tests)

### 3.12 Nullable Types ✅

- [x] **3.12.1** `type: ["string", "null"]` → `string | null`
- [ ] **3.12.2** `nullable: true` (OpenAPI compat) → add `| null`
- [x] **3.12.3** Write tests for nullable

### 3.13 Multiple Types ✅

- [x] **3.13.1** `type: ["string", "number"]` → `string | number`
- [x] **3.13.2** `type: ["object", "array"]` → `object | array`
- [x] **3.13.3** Write tests for multiple types

---

## Phase 4: TypeScript Code Generation

- [ ] **4.1** Create `generateTypeString(schema, name)` → produces type alias string
- [ ] **4.2** Create `generateInterface(schema, name)` → produces interface string
- [ ] **4.3** Handle proper indentation and formatting
- [ ] **4.4** Handle reserved TypeScript keywords in property names
- [ ] **4.5** Generate JSDoc comments from `description` field
- [ ] **4.6** Write tests for code generation

---

## Phase 5: Zod Schema Path

- [ ] **5.1** For schemas with `_zod`, extract internal JSON Schema representation
- [ ] **5.2** Use same JSON Schema to TS converter
- [ ] **5.3** Write tests comparing Zod path vs JSON Schema path for same logical schema

---

## Phase 6: Main API ✅

- [x] **6.1** Create `schemaToTs(schema, options)` main entry point
- [x] **6.2** Options: `{ name?: string, format?: 'type' | 'interface' }`
- [x] **6.3** Auto-detect schema type and route appropriately
- [x] **6.4** Write integration tests (8 tests)

---

## Phase 7: Edge Cases & Validation

- [ ] **7.1** Empty schema `{}` → `unknown`
- [ ] **7.2** `true` schema → `unknown` (accepts anything)
- [ ] **7.3** `false` schema → `never` (accepts nothing)
- [ ] **7.4** Deeply nested schemas (10+ levels)
- [ ] **7.5** Very wide objects (100+ properties)
- [ ] **7.6** Complex recursive schemas
- [ ] **7.7** Write stress tests

---

## Phase 8: Integration with Codemode

- [ ] **8.1** Update codemode's `generate-types.ts` to use this library
- [ ] **8.2** Test with real MCP tools using `jsonSchema()`
- [ ] **8.3** Test with real Zod schemas
- [ ] **8.4** Verify generated types match runtime behavior

---

## Phase 9: Documentation & Polish

- [ ] **9.1** Add README.md with usage examples
- [ ] **9.2** Add JSDoc comments to all exports
- [ ] **9.3** Add CHANGELOG.md
- [ ] **9.4** Final review and cleanup

---

## Test Matrix

Every test should verify both paths produce equivalent output:

| Schema Feature              | JSON Schema Input                                                                                                                   | Expected TypeScript Output        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| string                      | `{ type: "string" }`                                                                                                                | `string`                          |
| number                      | `{ type: "number" }`                                                                                                                | `number`                          |
| integer                     | `{ type: "integer" }`                                                                                                               | `number`                          |
| boolean                     | `{ type: "boolean" }`                                                                                                               | `boolean`                         |
| null                        | `{ type: "null" }`                                                                                                                  | `null`                            |
| const string                | `{ const: "foo" }`                                                                                                                  | `"foo"`                           |
| const number                | `{ const: 42 }`                                                                                                                     | `42`                              |
| const boolean               | `{ const: true }`                                                                                                                   | `true`                            |
| string enum                 | `{ enum: ["a", "b"] }`                                                                                                              | `"a" \| "b"`                      |
| number enum                 | `{ enum: [1, 2, 3] }`                                                                                                               | `1 \| 2 \| 3`                     |
| mixed enum                  | `{ enum: ["a", 1, null] }`                                                                                                          | `"a" \| 1 \| null`                |
| simple object               | `{ type: "object", properties: { name: { type: "string" } } }`                                                                      | `{ name?: string }`               |
| required props              | `{ type: "object", properties: { name: { type: "string" } }, required: ["name"] }`                                                  | `{ name: string }`                |
| optional props              | `{ type: "object", properties: { name: { type: "string" } } }`                                                                      | `{ name?: string }`               |
| nested object               | `{ type: "object", properties: { user: { type: "object", properties: { name: { type: "string" } } } } }`                            | `{ user?: { name?: string } }`    |
| additionalProperties true   | `{ type: "object", additionalProperties: true }`                                                                                    | `{ [key: string]: unknown }`      |
| additionalProperties false  | `{ type: "object", properties: { a: { type: "string" } }, additionalProperties: false }`                                            | `{ a?: string }`                  |
| additionalProperties schema | `{ type: "object", additionalProperties: { type: "number" } }`                                                                      | `{ [key: string]: number }`       |
| simple array                | `{ type: "array", items: { type: "string" } }`                                                                                      | `string[]`                        |
| array no items              | `{ type: "array" }`                                                                                                                 | `unknown[]`                       |
| tuple                       | `{ type: "array", prefixItems: [{ type: "string" }, { type: "number" }] }`                                                          | `[string, number]`                |
| tuple with rest             | `{ type: "array", prefixItems: [{ type: "string" }], items: { type: "number" } }`                                                   | `[string, ...number[]]`           |
| array of objects            | `{ type: "array", items: { type: "object", properties: { id: { type: "string" } } } }`                                              | `{ id?: string }[]`               |
| anyOf                       | `{ anyOf: [{ type: "string" }, { type: "number" }] }`                                                                               | `string \| number`                |
| allOf                       | `{ allOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "object", properties: { b: { type: "number" } } }] }` | `{ a?: string } & { b?: number }` |
| oneOf                       | `{ oneOf: [{ type: "string" }, { type: "number" }] }`                                                                               | `string \| number`                |
| nullable type               | `{ type: ["string", "null"] }`                                                                                                      | `string \| null`                  |
| multi type                  | `{ type: ["string", "number"] }`                                                                                                    | `string \| number`                |
| $ref                        | `{ $ref: "#/$defs/User", $defs: { User: { type: "object" } } }`                                                                     | `User` (with User type defined)   |
| recursive                   | Self-referential schema                                                                                                             | Proper recursive type             |
| description                 | `{ type: "string", description: "A name" }`                                                                                         | `/** A name */ string` or JSDoc   |
| empty schema                | `{}`                                                                                                                                | `unknown`                         |
| true schema                 | `true`                                                                                                                              | `unknown`                         |
| false schema                | `false`                                                                                                                             | `never`                           |

---

## Current Progress

✅ Phase 1: Project Setup - COMPLETE
✅ Phase 2: Schema Detection - COMPLETE
🔄 Phase 3: JSON Schema to TypeScript Core - IN PROGRESS (most items done)
⏳ Phase 4: TypeScript Code Generation - pending
⏳ Phase 5: Zod Schema Path - pending
✅ Phase 6: Main API - COMPLETE
⏳ Phase 7: Edge Cases & Validation - pending
⏳ Phase 8: Integration with Codemode - pending

**97 tests passing**

**Next:** Continue Phase 3 remaining items, then Phase 4, 5, 7, 8
