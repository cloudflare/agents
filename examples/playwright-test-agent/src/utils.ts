import type { ModelMessage, UIMessage } from "ai";
import type { RunAgentToolResult } from "agents";
import { testEvidenceSchema, type TestEvidence } from "./schema";

export function normalizeEvidence(
  result: RunAgentToolResult<TestEvidence>
): TestEvidence {
  if (result.status === "completed" && result.output) return result.output;
  return {
    evidence: [result.summary, result.error].filter(
      (part): part is string => typeof part === "string" && part.length > 0
    ),
    replayScript: "",
    trace: {
      agentStatus: result.status,
      summary: result.summary,
      error: result.error
    }
  };
}

export function parseEvidence(value: string): TestEvidence {
  try {
    const parsed = testEvidenceSchema.safeParse(parseJsonResponse(value));
    if (parsed.success) return parsed.data;
  } catch {
    // Fall through to a structured wrapper around the raw response.
  }
  return {
    evidence: value,
    replayScript: "",
    trace: { notes: "The sub-agent did not return structured evidence." }
  };
}

export function extractText(message: UIMessage | ModelMessage): string {
  const parts = "parts" in message ? message.parts : undefined;
  if (Array.isArray(parts)) {
    return parts
      .map((part) => {
        if (
          part !== null &&
          typeof part === "object" &&
          "type" in part &&
          part.type === "text" &&
          "text" in part &&
          typeof part.text === "string"
        ) {
          return part.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if ("content" in message && typeof message.content === "string") {
    return message.content;
  }
  return "";
}

export async function hashString(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function parseJsonResponse(value: string): unknown {
  const trimmed = value.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  if (fenced) return JSON.parse(fenced[1] ?? "");
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return JSON.parse(trimmed.slice(first, last + 1));
  }
  return JSON.parse(trimmed);
}
