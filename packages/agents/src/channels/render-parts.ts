import type { ChannelChunk, ChannelPartRenderingOptions } from "./channel";

type ToolStatus = {
  label: string;
  status: "running" | "completed" | "failed";
};

export type TextPartRenderer = {
  /** Record one chunk, returning whether its visible projection changed. */
  push(chunk: ChannelChunk): boolean;
  render(prefix?: string): string;
  hasContent(): boolean;
  hasNonText(): boolean;
};

/** Project selected rich stream parts into a compact text message. */
export function createTextPartRenderer(
  options: Required<ChannelPartRenderingOptions>
): TextPartRenderer {
  const tools = new Map<string, ToolStatus>();
  let answer = "";
  let reasoning = "";

  return {
    push(chunk) {
      switch (chunk.type) {
        case "text":
          if (chunk.text.length === 0) return false;
          answer += chunk.text;
          return true;
        case "reasoning":
          if (!options.reasoning || chunk.text.length === 0) return false;
          reasoning += chunk.text;
          return true;
        case "tool":
          if (!options.tools) return false;
          tools.set(chunk.id ?? chunk.name, {
            label: chunk.title ?? chunk.name,
            status: chunk.status === "started" ? "running" : chunk.status
          });
          return true;
        case "tool-input-start":
        case "tool-input-available":
        case "tool-input-error":
          if (!options.tools) return false;
          tools.set(chunk.toolCallId, {
            label: chunk.title ?? chunk.toolName,
            status: chunk.type === "tool-input-error" ? "failed" : "running"
          });
          return true;
        case "tool-output-available":
        case "tool-output-error":
        case "tool-output-denied": {
          if (!options.tools) return false;
          const prior = tools.get(chunk.toolCallId);
          tools.set(chunk.toolCallId, {
            label: prior?.label ?? chunk.toolCallId,
            status:
              chunk.type === "tool-output-available" && !chunk.preliminary
                ? "completed"
                : chunk.type === "tool-output-available"
                  ? "running"
                  : "failed"
          });
          return true;
        }
        default:
          return false;
      }
    },
    render(prefix = "") {
      if (reasoning.length === 0 && tools.size === 0) {
        return `${prefix}${answer}`;
      }
      const sections: string[] = [];
      if (tools.size > 0) {
        sections.push(
          `Tools\n${[...tools.values()]
            .map((tool) => `- ${tool.label}: ${tool.status}`)
            .join("\n")}`
        );
      }
      if (reasoning.length > 0) sections.push(`Reasoning\n${reasoning}`);
      if (answer.length > 0) sections.push(`Answer\n${answer}`);
      return `${prefix}${sections.join("\n\n")}`;
    },
    hasContent() {
      return answer.length > 0 || reasoning.length > 0 || tools.size > 0;
    },
    hasNonText() {
      return reasoning.length > 0 || tools.size > 0;
    }
  };
}
