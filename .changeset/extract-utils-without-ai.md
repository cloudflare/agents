---
"@cloudflare/codemode": minor
---

**BREAKING:** `generateTypes` and `ToolDescriptor`/`ToolDescriptors` types are no longer exported from the main entry point. Import them from `@cloudflare/codemode/ai` instead:

```ts
// Before
import { generateTypes } from "@cloudflare/codemode";

// After
import { generateTypes } from "@cloudflare/codemode/ai";
```

The main entry point (`@cloudflare/codemode`) no longer requires the `ai` or `zod` peer dependencies. It now exports:

- `sanitizeToolName` — sanitize tool names into valid JS identifiers
- `normalizeCode` — normalize LLM-generated code into async arrow functions
- `generateTypesFromJsonSchema` — generate TypeScript type definitions from plain JSON Schema (no AI SDK needed)
- `jsonSchemaToType` / `jsonSchemaToTypeString` — convert JSON Schema to TypeScript type strings
- `DynamicWorkerExecutor`, `ToolDispatcher` — sandboxed code execution
- `JsonSchemaToolDescriptor` / `JsonSchemaToolDescriptors` — types for the JSON Schema API

The `ai` and `zod` peer dependencies are now optional — only required when importing from `@cloudflare/codemode/ai`.
