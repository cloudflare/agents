/**
 * Extract displayable text from a cf_agent_chat stream chunk.
 * Used by print mode — interactive mode has its own chunk handler.
 */

const toolInputBuffers = new Map<string, { name: string; text: string }>();

export function extractText(chunk: unknown): string | null {
  if (!chunk || typeof chunk !== "object") return null;
  const c = chunk as Record<string, unknown>;

  if (c.type === "text-delta") {
    if (typeof c.textDelta === "string") return c.textDelta;
    if (typeof c.delta === "string") return c.delta;
  }

  if (c.type === "tool-input-start" && typeof c.toolName === "string") {
    const id = c.toolCallId as string;
    toolInputBuffers.set(id, { name: c.toolName, text: "" });
    return `\n> **${c.toolName}** `;
  }

  if (c.type === "tool-input-delta" && typeof c.inputTextDelta === "string") {
    const id = c.toolCallId as string;
    const buf = toolInputBuffers.get(id);
    if (buf) buf.text += c.inputTextDelta;
    return null;
  }

  if (c.type === "tool-input-available") {
    const id = c.toolCallId as string;
    const input = c.input as Record<string, unknown> | undefined;
    toolInputBuffers.delete(id);

    if (input?.code && typeof input.code === "string") {
      return `\n\`\`\`js\n${input.code}\n\`\`\`\n`;
    }
    const args = JSON.stringify(input, null, 2);
    return `(${args.length > 300 ? args.slice(0, 300) + "..." : args})\n`;
  }

  if (c.type === "tool-output-available") {
    const output = c.output as Record<string, unknown> | undefined;
    if (!output) return null;

    const logs = output.logs as string[] | undefined;
    let text = "";
    if (logs && logs.length > 0) {
      text += logs.map((l) => `  ${l}`).join("\n") + "\n";
    }

    const display = output.result ?? output.content ?? output;
    if (display === undefined || display === null) return text || null;

    const displayStr = typeof display === "string" ? display : JSON.stringify(display, null, 2);
    text += `\`\`\`\n${displayStr}\n\`\`\`\n`;
    return text;
  }

  if (c.type === "tool-result") {
    const r = c.result;
    const n = c.toolName ?? "tool";
    const t = typeof r === "string" ? r : JSON.stringify(r, null, 2);
    return `\n\`\`\`${n}\n${t}\n\`\`\`\n`;
  }

  if (c.type === "tool-call" && typeof c.toolName === "string") {
    const a = c.args;
    const s = typeof a === "string" ? a : JSON.stringify(a, null, 2);
    return `\n> **${c.toolName}**(${s.length > 200 ? s.slice(0, 200) + "..." : s})\n`;
  }

  return null;
}
