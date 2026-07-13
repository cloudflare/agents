import { z } from "zod";
import type { ChatMessage } from "../messages/model.js";
import type { ToolDescriptor } from "../../ports/model.js";

export type { ToolDescriptor } from "../../ports/model.js";

/** JSON-schema passthrough form: pre-built schema, bypassing zod entirely. */
export interface JsonSchemaInput {
  jsonSchema: unknown;
}

/**
 * Input/Output default to `any` (not `unknown`) so that a concretely-typed
 * `Tool<{ q: string }, string>` returned by `tool()` stays assignable to the
 * bare `Tool` used by `ToolSet`/`toDescriptor`/`ToolSet` values — the same
 * trick libraries like the AI SDK use to let a heterogeneous map of tools
 * (each with its own input type) collapse into one storage type.
 */
export interface Tool<Input = any, Output = any> {
  description: string;
  /** zod is preferred; { jsonSchema } is an escape hatch for hand-authored schemas. */
  inputSchema: z.ZodType<Input> | JsonSchemaInput;
  /**
   * No execute → client tool: the call is emitted to the client and the turn
   * waits for a client-provided result (or ends the turn; see doc 23).
   *
   * Declared with method shorthand (not an arrow-typed property) so its
   * parameter is checked bivariantly — belt-and-suspenders alongside the
   * `any` defaults above.
   */
  execute?(input: Input, ctx: ToolExecutionContext): Promise<Output> | Output;
  needsApproval?: boolean | ((input: Input) => boolean | Promise<boolean>);
  /** Capability grouping, action descriptors, etc. */
  metadata?: Record<string, unknown>;
}

export interface ToolExecutionContext {
  toolCallId: string;
  requestId: string;
  messages: ReadonlyArray<ChatMessage>;
  signal: AbortSignal;
}

export type ToolSet = Record<string, Tool>;

/** Identity helper; exists purely so callers get inference on Input/Output. */
export function tool<I, O>(def: Tool<I, O>): Tool<I, O> {
  return def;
}

export function toDescriptor(name: string, t: Tool): ToolDescriptor {
  const schema = t.inputSchema;
  const inputSchema = schema instanceof z.ZodType ? zodToJsonSchema(schema) : schema.jsonSchema;
  return { name, description: t.description, inputSchema };
}

// ---------------------------------------------------------------------------
// Minimal zod (v3) -> JSON Schema converter.
//
// Covers only what tool input schemas need: object/string/number/boolean/
// array/record/enum/union-of-literals/optional/default/nullable, plus
// .describe() descriptions. Anything else falls back to a permissive `{}`
// schema rather than throwing, since a slightly-too-loose schema is far less
// harmful to a tool call than a hard crash while assembling the tool list.
// ---------------------------------------------------------------------------

type ZodDef = { typeName: string; description?: string; [k: string]: unknown };

function zodDef(schema: z.ZodType): ZodDef {
  return (schema as unknown as { _def: ZodDef })._def;
}

function isOptionalMember(schema: z.ZodType): boolean {
  const typeName = zodDef(schema).typeName;
  return typeName === "ZodOptional" || typeName === "ZodDefault";
}

function primitiveJsonType(value: unknown): string | undefined {
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return undefined;
  }
}

function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const def = zodDef(schema);
  const base = convertDef(def);
  if (typeof def.description === "string") {
    return { ...base, description: def.description };
  }
  return base;
}

function convertDef(def: ZodDef): Record<string, unknown> {
  switch (def.typeName) {
    case "ZodObject": {
      const shape = (def.shape as () => Record<string, z.ZodType>)();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value);
        if (!isOptionalMember(value)) {
          required.push(key);
        }
      }
      const result: Record<string, unknown> = { type: "object", properties };
      if (required.length > 0) {
        result.required = required;
      }
      return result;
    }

    case "ZodString":
      return { type: "string" };

    case "ZodNumber": {
      const checks = (def.checks as Array<{ kind: string }>) ?? [];
      const isInt = checks.some((c) => c.kind === "int");
      return { type: isInt ? "integer" : "number" };
    }

    case "ZodBoolean":
      return { type: "boolean" };

    case "ZodArray":
      return { type: "array", items: zodToJsonSchema(def.type as z.ZodType) };

    case "ZodRecord":
      return { type: "object", additionalProperties: zodToJsonSchema(def.valueType as z.ZodType) };

    case "ZodEnum":
      return { type: "string", enum: [...(def.values as string[])] };

    case "ZodLiteral": {
      const type = primitiveJsonType(def.value);
      return type ? { type, enum: [def.value] } : { enum: [def.value] };
    }

    case "ZodUnion": {
      const options = def.options as z.ZodType[];
      const optionDefs = options.map(zodDef);
      if (optionDefs.every((d) => d.typeName === "ZodLiteral")) {
        const values = optionDefs.map((d) => d.value);
        const type = primitiveJsonType(values[0]);
        return type ? { type, enum: values } : { enum: values };
      }
      return { anyOf: options.map((o) => zodToJsonSchema(o)) };
    }

    case "ZodOptional":
      return zodToJsonSchema(def.innerType as z.ZodType);

    case "ZodDefault": {
      const inner = zodToJsonSchema(def.innerType as z.ZodType);
      const defaultValue = (def.defaultValue as () => unknown)();
      return { ...inner, default: defaultValue };
    }

    case "ZodNullable": {
      const inner = zodToJsonSchema(def.innerType as z.ZodType);
      const innerType = inner.type;
      if (typeof innerType === "string") {
        return { ...inner, type: [innerType, "null"] };
      }
      return { anyOf: [inner, { type: "null" }] };
    }

    default:
      // Unknown/unsupported zod type (any, unknown, function, date, ...): a
      // permissive schema is safer than throwing while assembling tools.
      return {};
  }
}
