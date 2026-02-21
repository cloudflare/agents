import {
  zodToTs,
  printNode as printNodeZodToTs,
  createTypeAlias,
  createAuxiliaryTypeStore
} from "zod-to-ts";
import type { ZodType } from "zod";
import type { ToolSet } from "ai";

const JS_RESERVED = new Set([
  "abstract",
  "arguments",
  "await",
  "boolean",
  "break",
  "byte",
  "case",
  "catch",
  "char",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "double",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "final",
  "finally",
  "float",
  "for",
  "function",
  "goto",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "int",
  "interface",
  "let",
  "long",
  "native",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "short",
  "static",
  "super",
  "switch",
  "synchronized",
  "this",
  "throw",
  "throws",
  "transient",
  "true",
  "try",
  "typeof",
  "undefined",
  "var",
  "void",
  "volatile",
  "while",
  "with",
  "yield"
]);

/**
 * Sanitize a tool name into a valid JavaScript identifier.
 * Replaces hyphens, dots, and spaces with `_`, strips other invalid chars,
 * prefixes digit-leading names with `_`, and appends `_` to JS reserved words.
 */
export function sanitizeToolName(name: string): string {
  if (!name) return "_";

  // Replace common separators with underscores
  let sanitized = name.replace(/[-.\s]/g, "_");

  // Strip any remaining non-identifier characters
  sanitized = sanitized.replace(/[^a-zA-Z0-9_$]/g, "");

  if (!sanitized) return "_";

  // Prefix with _ if starts with a digit
  if (/^[0-9]/.test(sanitized)) {
    sanitized = "_" + sanitized;
  }

  // Append _ to reserved words
  if (JS_RESERVED.has(sanitized)) {
    sanitized = sanitized + "_";
  }

  return sanitized;
}

function toCamelCase(str: string) {
  return str
    .replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
    .replace(/^[a-z]/, (letter) => letter.toUpperCase());
}

/**
 * Extract field descriptions from a Zod object schema's `.shape`, if available.
 * Returns an array of `@param input.fieldName - description` lines.
 */
function extractParamDescriptions(schema: ZodType): string[] {
  const descriptions: string[] = [];
  const shape = (schema as { shape?: Record<string, ZodType> }).shape;
  if (!shape || typeof shape !== "object") return descriptions;

  for (const [fieldName, fieldSchema] of Object.entries(shape)) {
    const desc = (fieldSchema as { description?: string }).description;
    if (desc) {
      descriptions.push(`@param input.${fieldName} - ${desc}`);
    }
  }
  return descriptions;
}

export interface ToolDescriptor {
  description?: string;
  inputSchema: ZodType;
  outputSchema?: ZodType;
  execute?: (args: unknown) => Promise<unknown>;
}

export type ToolDescriptors = Record<string, ToolDescriptor>;

/**
 * Safely convert a Zod schema to TypeScript type string.
 * Returns "unknown" if the schema cannot be represented in TypeScript.
 */
function safeZodToTs(
  schema: ZodType,
  typeName: string,
  auxiliaryTypeStore: ReturnType<typeof createAuxiliaryTypeStore>
): string {
  try {
    const result = zodToTs(schema, { auxiliaryTypeStore });
    return printNodeZodToTs(createTypeAlias(result.node, typeName));
  } catch {
    // If the schema cannot be represented (e.g., transform), fall back to unknown
    return `type ${typeName} = unknown`;
  }
}

/**
 * Generate TypeScript type definitions from tool descriptors or an AI SDK ToolSet.
 * These types can be included in tool descriptions to help LLMs write correct code.
 */
export function generateTypes(tools: ToolDescriptors | ToolSet): string {
  let availableTools = "";
  let availableTypes = "";

  const auxiliaryTypeStore = createAuxiliaryTypeStore();

  for (const [toolName, tool] of Object.entries(tools)) {
    // Handle both our ToolDescriptor and AI SDK Tool types
    const inputSchema =
      "inputSchema" in tool ? tool.inputSchema : tool.parameters;
    const outputSchema = "outputSchema" in tool ? tool.outputSchema : undefined;
    const description = tool.description;

    const safeName = sanitizeToolName(toolName);

    const inputType = safeZodToTs(
      inputSchema as ZodType,
      `${toCamelCase(safeName)}Input`,
      auxiliaryTypeStore
    );

    const outputType = outputSchema
      ? safeZodToTs(
          outputSchema as ZodType,
          `${toCamelCase(safeName)}Output`,
          auxiliaryTypeStore
        )
      : `type ${toCamelCase(safeName)}Output = unknown`;

    availableTypes += `\n${inputType.trim()}`;
    availableTypes += `\n${outputType.trim()}`;

    // Build JSDoc comment with description and param descriptions
    const paramDescs = extractParamDescriptions(inputSchema as ZodType);
    const jsdocLines: string[] = [];
    if (description?.trim()) {
      jsdocLines.push(description.trim());
    } else {
      jsdocLines.push(toolName);
    }
    for (const pd of paramDescs) {
      jsdocLines.push(pd);
    }

    const jsdocBody = jsdocLines.map((l) => `\t * ${l}`).join("\n");
    availableTools += `\n\t/**\n${jsdocBody}\n\t */`;
    availableTools += `\n\t${safeName}: (input: ${toCamelCase(safeName)}Input) => Promise<${toCamelCase(safeName)}Output>;`;
    availableTools += "\n";
  }

  availableTools = `\ndeclare const codemode: {${availableTools}}`;

  return `
${availableTypes}
${availableTools}
  `.trim();
}
