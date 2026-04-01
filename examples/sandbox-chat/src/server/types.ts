import type { UIMessage } from "ai";

// ── Server → client message protocol ─────────────────────────────────

export type ServerMessage =
  | {
      type: "file-change";
      eventType: string;
      path: string;
      isDirectory: boolean;
    }
  | { type: "preview-url"; url: string; port: number };

// ── Coder tool output ───────────────────────────────────────────────

/**
 * Shared output type for every yield of the `coder` async-generator tool.
 * Preliminary yields carry the growing sub-conversation; the final yield
 * includes the completed conversation and optional summary.
 */
export type CoderToolOutput = {
  /** Overall lifecycle status. */
  status: "working" | "complete" | "error";
  /** OpenCode session ID for correlation. */
  sessionId: string;
  /** Sub-conversation messages using AI SDK's native UIMessage format. */
  messages: UIMessage[];
  /** Final summary text (only on status === "complete"). */
  summary?: string;
  /** Error description (only on status === "error"). */
  error?: string;
};
