# 08 — Tool registry, wrapping, and client tools

Original: tools reach the turn from many sources — `getTools()` (AI SDK
ToolSet), workspace tools, skills tools, MCP tools, client-declared tools from
the request body, extension tools, and compiled actions. Think wraps every
tool's `execute` to fire `beforeToolCall`/`afterToolCall` hooks and honor
hook decisions, and appends a "capability block" to the system prompt
describing available tool families. That wiring is scattered through think.ts;
the rebuild centralizes it.

## 1. Tool definition (rebuild-owned)

```ts
import type { z } from "zod";

export interface ToolDescriptor {              // what the model sees (ports/model.ts re-exports this)
  name: string;
  description: string;
  inputSchema: unknown;                        // JSON schema object
}
export interface Tool<Input = unknown, Output = unknown> {
  description: string;
  inputSchema: z.ZodType<Input> | { jsonSchema: unknown };   // zod preferred
  execute?: (input: Input, ctx: ToolExecutionContext) => Promise<Output> | Output;
  /** No execute → client tool: the call is emitted to the client and the turn
      waits for a client-provided result (or ends the turn; see doc 23). */
  needsApproval?: boolean | ((input: Input) => boolean | Promise<boolean>);
  metadata?: Record<string, unknown>;          // capability grouping, action descriptors...
}
export interface ToolExecutionContext {
  toolCallId: string; requestId: string;
  messages: ReadonlyArray<ChatMessage>;
  signal: AbortSignal;
}
export type ToolSet = Record<string, Tool>;
export function tool<I, O>(def: Tool<I, O>): Tool<I, O>;      // identity helper for inference
export function toDescriptor(name: string, t: Tool): ToolDescriptor;  // zod → JSON schema via z.toJSONSchema (zod v3.24+: use zod-to-json-schema-free approach: accept both; if zod lacks native conversion, hand-roll a minimal converter for object/string/number/boolean/array/enum/optional/default — enough for tool schemas)
```

## 2. `domain/tools/registry.ts` — assembly & wrapping

### Responsibilities
- **Merge order** (later sources win on name collision, matching original
  precedence where user tools override built-ins):
  1. built-in tools (workspace, skills, session context tools)
  2. external sources (MCP port)
  3. actions (doc 12, compiled)
  4. `getTools()` user tools
  5. client tools (from the connect/request body; never override a server tool
     — a client tool colliding with a server name is dropped with a warning)
- **Hook wrapping**: wrap each tool's execute so that per call:
  - `beforeToolCall(ctx)` may return a decision:
    `{ action: "allow", input? }` (substituted input), `{ action: "block", reason? }`
    (execute skipped; model sees `{ blocked: true, reason }` as output),
    `{ action: "substitute", output }` (execute skipped; model sees output).
  - `afterToolCall(ctx)` fires after success OR failure with
    `{ toolCallId, toolName, input, durationMs, stepNumber }` plus
    discriminated `success/output/error`.
  - Zod validation of input before execute; validation failure → error value
    output (`{ error: { name: "ToolInputValidationError", message } }`), not a
    crash.
  - A thrown execute → error value output; the turn continues (the model sees
    the error), except AbortedError which propagates to cancel the step.
- **Filtering**: apply channel policy filter `(all: ToolSet) => ToolSet`
  (remove-only; doc 18) and `activeTools?: string[]` narrowing from TurnConfig.
- **Capability prompt block**: `describeCapabilities(tools)` returns a short
  deterministic text block grouping tools by `metadata.capability`
  (workspace / skills / execution / external / delegation / client) — appended
  to the system prompt each turn only for families actually present.

### Proposed interface
```ts
export interface ToolCallDecision { action: "allow" | "block" | "substitute"; input?: unknown; output?: unknown; reason?: string }
export interface ToolHooks {
  beforeToolCall?: (ctx: { toolName: string; toolCallId: string; input: unknown; stepNumber: number;
                           messages: ReadonlyArray<ChatMessage>; signal: AbortSignal })
    => void | ToolCallDecision | Promise<void | ToolCallDecision>;
  afterToolCall?: (ctx: { toolName: string; toolCallId: string; input: unknown; stepNumber: number;
                          durationMs: number } & ({ success: true; output: unknown } | { success: false; error: ErrorValue }))
    => void | Promise<void>;
}
export interface AssembledTools {
  tools: ToolSet;                                   // wrapped, post-merge
  descriptors(activeTools?: string[]): ToolDescriptor[];
  execute(name: string, input: unknown, ctx: ToolExecutionContext): Promise<{ output: unknown; isError: boolean }>;
  isClientTool(name: string): boolean;
  needsApproval(name: string, input: unknown): Promise<boolean>;
  capabilityBlock(): string;
}
export function assembleTools(sources: {
  builtin?: ToolSet; external?: ToolSet; actions?: ToolSet; user?: ToolSet; client?: ToolSet;
}, options: { hooks?: ToolHooks; filter?: (all: ToolSet) => ToolSet; clock: Clock }): AssembledTools;
```

### Client tools (behavioral spec, enforced with doc 23)
- Client tools are declared per-request (name/description/JSON schema).
- When the model calls one, the loop emits `tool-input-available` with
  `executor: "client"` and pauses that tool call: the turn's step **ends** and
  the assistant message persists with the tool part in `input-available`.
- The client later sends a tool result (`cf_agent_tool_result`); Think applies
  it to the persisted message, broadcasts the update, and (if all pending tool
  parts are settled) triggers auto-continuation (doc 23).
- Approval flow: tools with `needsApproval` emit `tool-approval-requested`
  and wait for `cf_agent_tool_approval` (approve → execute server-side or
  emit to client; reject → tool part becomes output-error "denied").

### Tests
- merge precedence & client-collision drop; before-hook allow/substitute/block;
  after-hook on success and thrown error; zod validation failure as value;
  filter is remove-only (adding in filter throws); capabilityBlock stability;
  descriptor conversion for zod object schemas (string/number/enum/optional).
