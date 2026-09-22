import type { JSON } from "../protocol";

/** Framework-neutral tool context owned by the durable loop. */
export type ToolExecutionContext = {
  readonly toolCallId: string;
  readonly abortSignal: AbortSignal;
};

export type StandardSchema = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown
    ) =>
      | { readonly value: unknown; readonly issues?: undefined }
      | { readonly issues: readonly unknown[] }
      | Promise<
          | { readonly value: unknown; readonly issues?: undefined }
          | { readonly issues: readonly unknown[] }
        >;
  };
};

/** A tool declaration and optional server implementation. */
export type ServerTool = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: StandardSchema;
  readonly needsApproval?: boolean;
  readonly execute?: (
    input: JSON,
    context: ToolExecutionContext
  ) => Promise<unknown>;
};

export async function validateToolInput(
  tool: ServerTool,
  input: unknown
): Promise<{ ok: true; value: JSON } | { ok: false; error: string }> {
  const result = await tool.inputSchema["~standard"].validate(input);
  if (result.issues) {
    return {
      ok: false,
      error: `Invalid input for ${tool.name}: ${JSON.stringify(result.issues)}`
    };
  }
  try {
    const encoded = JSON.stringify(result.value);
    if (encoded === undefined) throw new Error("schema returned undefined");
    return { ok: true, value: JSON.parse(encoded) as JSON };
  } catch (error) {
    return {
      ok: false,
      error: `Invalid input for ${tool.name}: result is not JSON (${error instanceof Error ? error.message : String(error)})`
    };
  }
}

export function normalizeToolOutput(
  value: unknown,
  maxBytes = 128 * 1024
): JSON {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return null;
  const bytes = new TextEncoder().encode(encoded).length;
  if (bytes <= maxBytes) return JSON.parse(encoded) as JSON;
  return {
    truncated: true,
    originalBytes: bytes,
    preview: bound(encoded, maxBytes)
  };
}

export type ToolBundle = {
  readonly tools: readonly ServerTool[];
  readonly gated: readonly string[];
};

/** Bound a string for a model-visible preview on a UTF-8 boundary. */
export function bound(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  const decoded = new TextDecoder("utf-8").decode(bytes.subarray(0, maxBytes));
  return `${decoded}\n… (truncated at ${maxBytes} of ${bytes.length} bytes)`;
}
