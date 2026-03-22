---
"@cloudflare/codemode": patch
---

feat: add TanStack AI integration (`@cloudflare/codemode/tanstack-ai`)

New entry point for using codemode with TanStack AI's `chat()` instead of the Vercel AI SDK's `streamText()`.

```typescript
import {
  createCodeTool,
  tanstackTools
} from "@cloudflare/codemode/tanstack-ai";
import { chat } from "@tanstack/ai";

const codeTool = createCodeTool({
  tools: [tanstackTools(myServerTools)],
  executor
});

const stream = chat({ adapter, tools: [codeTool], messages });
```

**Exports:**

- `createCodeTool` — returns a TanStack AI `ServerTool` (via `toolDefinition().server()`)
- `tanstackTools` — converts a `TanStackTool[]` into a `ToolProvider` with pre-generated types
- `generateTypes` — generates TypeScript type definitions from TanStack AI tools
- `resolveProvider` — re-exported framework-agnostic provider resolver

**Internal cleanup:** extracted `resolveProvider` into a framework-agnostic `resolve.ts` module so the main entry (`@cloudflare/codemode`) no longer pulls in the `ai` package at runtime. Shared constants and helpers moved to `shared.ts` to avoid duplication between the AI SDK and TanStack AI entry points.
