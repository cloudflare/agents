import {
  type Component,
  truncateToWidth,
  wrapTextWithAnsi
} from "@earendil-works/pi-tui";
import { c, theme } from "../theme";
import { formatDuration, type Status } from "../view";
import { type Context, spinner } from "./blocks";

const firstLine = (text: string) => text.split("\n")[0] ?? "";

/** The reconnecting banner, queued turns and unacknowledged sends. */
export class PendingView implements Component {
  status: Status | undefined;
  /** Names of tool calls waiting on this participant. */
  prompts: readonly string[] = [];

  render(width: number): string[] {
    const status = this.status;
    if (!status) return [];
    const lines: string[] = [];
    if (status.seen && !status.connected) {
      lines.push(
        theme.warn("⚠ Reconnecting… sends wait and go out on reconnect")
      );
    }
    for (const name of this.prompts) {
      lines.push(
        theme.warn(`◆ ${name} needs you ${c.dim("(↑ to select it)")}`)
      );
    }
    for (const turn of status.queued) {
      const label = turn.yours
        ? `"${firstLine(turn.label)}"`
        : c.italic("from another participant");
      lines.push(`${theme.muted("⧗ queued ")} ${label}`);
    }
    for (const pending of status.sending) {
      lines.push(
        `${theme.muted("↑ sending")} "${firstLine(pending.label)}" ${c.dim("(not acknowledged)")}`
      );
    }
    if (lines.length === 0) return [];
    return ["", ...lines.map((line) => truncateToWidth(line, width))];
  }

  invalidate(): void {}
}

export class StatusBar implements Component {
  status: Status | undefined;
  /** Replaces the status line while set. */
  hint: string | undefined;

  constructor(
    public conversation: string,
    readonly context: Context
  ) {}

  render(width: number): string[] {
    if (this.hint) return [truncateToWidth(c.dim(this.hint), width)];
    const status = this.status;
    if (!status) return [];
    const connection = status.connected
      ? theme.ok("● connected")
      : status.seen
        ? theme.warn("◌ reconnecting")
        : theme.muted("◌ connecting");
    const parts = [connection];
    if (status.running) {
      const { seconds, yours, cancelling } = status.running;
      const time = seconds === undefined ? "" : ` ${formatDuration(seconds)}`;
      const frame = spinner[this.context.frame % spinner.length];
      parts.push(
        `${theme.accent(frame)} running${time} ${c.dim(yours ? "(yours)" : "(another participant's)")}`
      );
      parts.push(cancelling ? theme.warn("cancelling…") : c.dim("Esc cancels"));
    }
    if (status.awaiting > 0) {
      parts.push(theme.warn(`${status.awaiting} awaiting input`));
    }
    if (status.you) parts.push(`you: ${theme.accent(status.you)}`);
    parts.push(c.dim(this.conversation));
    return [truncateToWidth(parts.join(c.dim(" · ")), width)];
  }

  invalidate(): void {}
}

export const keyHelp =
  "Enter send · Shift+Enter new line · ↑ select a block · Ctrl+O tools · Ctrl+T thinking · Esc cancel · Ctrl+C quit";

/** Printed once at the top; scrolls away with the transcript. */
export class Header implements Component {
  constructor(public conversation: string) {}

  render(width: number): string[] {
    return [
      truncateToWidth(
        `${theme.accent("◆ Channels")} ${c.dim(this.conversation)}`,
        width
      ),
      ...wrapTextWithAnsi(c.dim(keyHelp), Math.max(1, width)).map((line) =>
        truncateToWidth(line, width)
      )
    ];
  }

  invalidate(): void {}
}
