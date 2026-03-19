/**
 * Shared rendering helpers for message parts.
 * Used by both live streaming (handleChunk) and history restore.
 */

import { Text, Markdown, Box, Spacer } from "@mariozechner/pi-tui";
import { fg, mdTheme, toolPendBg, chalk } from "./theme.js";

/** Render tool input into a Box — code block or key:value args */
export function renderToolInput(box: Box, input: Record<string, unknown> | undefined): void {
  if (!input) return;
  if (input.code && typeof input.code === "string") {
    box.addChild(new Markdown("```js\n" + input.code + "\n```", 0, 0, mdTheme));
  } else {
    const args = Object.entries(input)
      .map(([k, v]) => `${fg.dim(k + ":")} ${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join("  ");
    box.addChild(new Text(fg.dim(args), 0, 0));
  }
}

/** Render tool output (logs + result) into a Box */
export function renderToolOutput(box: Box, output: Record<string, unknown> | undefined): void {
  if (!output) return;

  const logs = output.logs as string[] | undefined;
  const display = output.result ?? output.content;

  if (logs && logs.length > 0) {
    box.addChild(new Text(fg.dim(logs.join("\n")), 0, 0));
  }
  if (display !== undefined && display !== null) {
    const s = typeof display === "string" ? display : JSON.stringify(display, null, 2);
    const lines = s.split("\n");
    const shown = lines.length > 20
      ? lines.slice(0, 20).join("\n") + `\n${fg.dim(`... ${lines.length - 20} more lines`)}`
      : s;
    box.addChild(new Spacer(1));
    box.addChild(new Text(fg.muted(shown), 0, 0));
  }
}

/** Create a tool call Box with name header */
export function createToolBox(toolName: string): Box {
  const box = new Box(1, 0, toolPendBg);
  box.addChild(new Text(chalk.bold(toolName), 0, 0));
  return box;
}

/** Render a complete tool part (from stored message) into components */
export function renderToolPart(part: Record<string, unknown>): [Spacer, Box] {
  const box = createToolBox(part.toolName as string);
  renderToolInput(box, part.input as Record<string, unknown> | undefined);
  renderToolOutput(box, part.output as Record<string, unknown> | undefined);

  if (part.state === "output-error") {
    const errMsg = (part.output as Record<string, unknown>)?.error ?? "error";
    box.addChild(new Text(fg.error(String(errMsg)), 0, 0));
  }

  return [new Spacer(1), box];
}
