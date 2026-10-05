/**
 * Helpers shared by the browser tools: `createBrowserTools` in `ai.ts`, and
 * `browserTool` in `ai-sdk.ts`, `tanstack-ai.ts`, and `pi.ts`. Internal — not an entry
 * point.
 */
import type { JSONValue } from "ai";
import { truncateResult } from "@cloudflare/codemode";
import { redactBase64Payloads } from "../core/base64-redaction";
import { __DO_NOT_USE_WILL_BREAK__agentContext as agentContext } from "../internal_context";

interface BrowserScreenshotOutput {
  type: "browser_screenshot";
  mediaType: string;
  data: string;
}

export function browserScreenshotOutput(
  value: unknown
): BrowserScreenshotOutput | null {
  const outer =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  const result =
    outer && typeof outer.result === "object" && outer.result !== null
      ? (outer.result as Record<string, unknown>)
      : outer;
  if (
    result?.type !== "browser_screenshot" ||
    typeof result.mediaType !== "string" ||
    typeof result.data !== "string"
  ) {
    return null;
  }
  return result as unknown as BrowserScreenshotOutput;
}

export function transformBrowserResult(value: unknown): unknown {
  // Keep canonical screenshot output intact for UIMessage persistence and the
  // chat renderer. Other results are redacted before truncation so a nested
  // binary payload cannot become a large serialized preview.
  return browserScreenshotOutput(value)
    ? value
    : truncateResult(redactBase64Payloads(value));
}

/** What the model sees in place of a browser tool's output. */
export type BrowserModelOutput =
  | { type: "text"; value: string }
  | { type: "json"; value: JSONValue };

/**
 * @param notes Sentences appended when a screenshot collapses the output to
 * text, so notices on the output aren't lost with it.
 */
export function browserExecuteModelOutput(
  output: unknown,
  notes: string[] = []
): BrowserModelOutput {
  const screenshot = browserScreenshotOutput(output);
  if (screenshot) {
    const approximateBytes = Math.floor((screenshot.data.length * 3) / 4);
    return {
      type: "text",
      value: [
        `Screenshot captured successfully (${screenshot.mediaType}, approximately ${approximateBytes.toLocaleString()} bytes); the image is kept for the UI and omitted here.`,
        ...notes
      ].join(" ")
    };
  }

  // `calls` is the durable audit log; like the codemode tool's own projection,
  // it stays on the persisted part and never enters the model's context, and
  // the sandbox `logs` are bounded like a result.
  const modelFacing =
    typeof output === "object" && output !== null && !Array.isArray(output)
      ? (({ calls: _calls, ...rest }: { calls?: unknown; logs?: unknown }) => ({
          ...rest,
          ...(Array.isArray(rest.logs)
            ? { logs: truncateResult(rest.logs) }
            : {})
        }))(output)
      : output;
  const redacted = redactBase64Payloads(modelFacing);
  try {
    const serialized = JSON.stringify(redacted);
    return {
      type: "json",
      value:
        serialized === undefined ? null : (JSON.parse(serialized) as JSONValue)
    };
  } catch {
    return {
      type: "text",
      value:
        "Browser execution completed, but its result could not be serialized for model context."
    };
  }
}

/**
 * The Durable Object state to build the runtime in: the explicit `ctx` if
 * given, otherwise the current Agent's `ctx` (via `getCurrentAgent()`), so
 * `createBrowserRuntime` can be called from an Agent method without threading
 * `this.ctx` through.
 */
export function resolveCtx(options: {
  ctx?: DurableObjectState;
}): DurableObjectState | undefined {
  if (options.ctx) return options.ctx;
  const agent = agentContext.getStore()?.agent as
    | { ctx?: DurableObjectState }
    | undefined;
  return agent?.ctx;
}
