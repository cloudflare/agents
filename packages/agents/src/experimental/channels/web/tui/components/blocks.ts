import {
  type Component,
  Container,
  Markdown,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi
} from "@earendil-works/pi-tui";
import { highlightCode, highlightJson } from "../highlight";
import {
  type Block,
  isExpanded,
  type ToolPhase,
  toolPhase,
  type Ui
} from "../view";
import { c, markdownTheme, theme } from "../theme";

export const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Shared by blocks at render time. */
export type Context = { frame: number; ui: Ui; you?: string };

interface BlockComponent extends Component {
  update(block: Block): void;
}

/** The transcript, one component per block, reused across updates by key. */
export class TranscriptView extends Container {
  readonly #byKey = new Map<string, BlockComponent>();

  constructor(readonly context: Context) {
    super();
  }

  update(blocks: readonly Block[]): void {
    const next = new Map<string, BlockComponent>();
    for (const block of blocks) {
      let component = this.#byKey.get(block.key);
      if (!component) component = create(block, this.context);
      component.update(block);
      next.set(block.key, component);
    }
    this.#byKey.clear();
    for (const [key, component] of next) this.#byKey.set(key, component);
    this.children = [...next.values()];
  }

  override render(width: number): string[] {
    const lines: string[] = [];
    for (const child of this.children) {
      const rendered = child.render(width);
      if (rendered.length === 0) continue;
      lines.push("", ...rendered.map((line) => truncateToWidth(line, width)));
    }
    return lines;
  }
}

function create(block: Block, context: Context): BlockComponent {
  switch (block.kind) {
    case "text":
      return new TextBlock();
    case "reasoning":
      return new ReasoningBlock(context);
    case "tool":
      return new ToolBlock(context);
    default:
      return new LineBlock();
  }
}

class TextBlock implements BlockComponent {
  readonly #markdown = new Markdown("", 0, 0, {
    ...markdownTheme,
    highlightCode
  });
  #text = "";

  update(block: Block): void {
    if (block.kind !== "text" || block.text === this.#text) return;
    this.#text = block.text;
    this.#markdown.setText(block.text);
  }

  render(width: number): string[] {
    return this.#text ? this.#markdown.render(width) : [];
  }

  invalidate(): void {
    this.#markdown.invalidate();
  }
}

class ReasoningBlock implements BlockComponent {
  #block: Extract<Block, { kind: "reasoning" }> | undefined;

  constructor(readonly context: Context) {}

  update(block: Block): void {
    if (block.kind === "reasoning") this.#block = block;
  }

  render(width: number): string[] {
    const block = this.#block;
    if (!block) return [];
    const { ui, frame } = this.context;
    const expanded = isExpanded(block, ui);
    const mark = block.streaming
      ? theme.accent(spinner[frame % spinner.length])
      : expanded
        ? "▾"
        : "▸";
    const label = block.streaming ? "Thinking…" : "Thought";
    let head = `${mark} ${label} ${formatChars(block.text.length)}`;
    head = ui.selected === block.key ? c.inverse(head) : c.dim(head);
    const lines = [truncateToWidth(head, width)];
    if (expanded) {
      for (const line of wrap(block.text.trim(), width - 2)) {
        lines.push(`  ${c.dim(c.italic(line))}`);
      }
    }
    return lines;
  }

  invalidate(): void {}
}

const phaseLabels: Record<ToolPhase, [string, (s: string) => string]> = {
  preparing: ["preparing", theme.muted],
  running: ["running", theme.accent],
  approval: ["? awaiting approval", theme.warn],
  client: ["awaiting a client result", theme.warn],
  done: ["✓ done", theme.ok],
  error: ["✗ error", theme.error],
  denied: ["⊘ denied", theme.error],
  stopped: ["stopped", theme.muted]
};

class ToolBlock implements BlockComponent {
  #block: Extract<Block, { kind: "tool" }> | undefined;

  constructor(readonly context: Context) {}

  update(block: Block): void {
    if (block.kind === "tool") this.#block = block;
  }

  render(width: number): string[] {
    const block = this.#block;
    if (!block) return [];
    const { part } = block;
    const { ui, frame } = this.context;
    const phase = toolPhase(part, block.turn);
    const [label, tone] = toolLabel(block, phase, this.context.you);
    const busy = phase === "preparing" || phase === "running" || block.sending;
    let state = tone(
      busy ? `${spinner[frame % spinner.length]} ${label}` : label
    );
    if (phase === "approval" && block.yours === false) {
      state = `${c.dim("their turn ·")} ${state}`;
    }
    const selected = ui.selected === block.key;
    const name = c.bold(part.title ?? part.toolName);
    const hint = block.sending
      ? undefined
      : actionHint(block, phase, this.context.you);

    if (!isExpanded(block, ui)) {
      const summary = part.output ?? part.errorText ?? part.input;
      const tail = summary === undefined ? "" : `  ${c.dim(oneLine(summary))}`;
      const head = `▸ ◆ ${name} ${state}${tail}`;
      const lines = [truncateToWidth(selected ? c.inverse(head) : head, width)];
      if (hint && selected)
        lines.push(truncateToWidth(`  ${theme.accent(hint)}`, width));
      return lines;
    }

    const border = selected
      ? theme.accent
      : phase === "approval" || phase === "client"
        ? theme.warn
        : phase === "error"
          ? theme.error
          : theme.border;
    const inner = Math.max(1, width - 4);
    const body: string[] = [];
    const section = (title: string, lines: string[]) => {
      body.push(c.dim(title));
      for (const line of lines) body.push(...wrapTextWithAnsi(line, inner));
    };
    section(
      "input",
      part.input === undefined ? [c.dim("…")] : highlightJson(part.input)
    );
    if (part.output !== undefined) {
      section(
        part.preliminary ? "output (partial)" : "output",
        highlightJson(part.output)
      );
    }
    if (part.errorText)
      section("error", wrap(part.errorText, inner).map(theme.error));
    if (part.approval?.reason) section("reason", [part.approval.reason]);
    if (hint)
      body.push(
        selected ? theme.accent(hint) : c.dim(`${hint} (select with ↑)`)
      );
    return card(`◆ ${name}`, state, body, width, border);
  }

  invalidate(): void {}
}

function toolLabel(
  block: Extract<Block, { kind: "tool" }>,
  phase: ToolPhase,
  you: string | undefined
): [string, (s: string) => string] {
  if (block.sending) return ["sending answer", theme.muted];
  if (phase === "client") {
    const owner = block.part.owner;
    return owner === you
      ? ["awaiting your result", theme.warn]
      : [`waiting for ${owner}'s client`, theme.muted];
  }
  return phaseLabels[phase];
}

function actionHint(
  block: Extract<Block, { kind: "tool" }>,
  phase: ToolPhase,
  you: string | undefined
): string | undefined {
  if (phase === "approval") return "y approve · n deny · r deny with a reason";
  if (phase === "client" && block.part.owner === you) {
    return "Enter to answer";
  }
  return undefined;
}

/** A rounded box with a title on the left and a status on the right. */
export function card(
  title: string,
  status: string,
  body: readonly string[],
  width: number,
  border: (s: string) => string
): string[] {
  const inner = Math.max(1, width - 4);
  const fill = Math.max(
    1,
    width - visibleWidth(title) - visibleWidth(status) - 6
  );
  const right = status ? `${status}${border(" ╮")}` : border("─╮");
  const top = `${border("╭ ")}${title}${border(` ${"─".repeat(fill)} `)}${right}`;
  const lines = [truncateToWidth(top, width)];
  for (const line of body) {
    const text = truncateToWidth(line, inner);
    const pad = " ".repeat(Math.max(0, inner - visibleWidth(text)));
    lines.push(`${border("│")} ${text}${pad} ${border("│")}`);
  }
  lines.push(border(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
  return lines.map((line) => truncateToWidth(line, width));
}

function oneLine(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ")
    : JSON.stringify(value);
}

/** User, system, attachment and notice blocks. */
class LineBlock implements BlockComponent {
  #lines: (width: number) => string[] = () => [];

  update(block: Block): void {
    switch (block.kind) {
      case "user": {
        const gutter = block.from.you ? theme.you("▌") : theme.other("▌");
        const name = block.from.you
          ? theme.you("you")
          : theme.other(block.from.name ?? "another participant");
        this.#lines = (width) => [
          `${gutter} ${name}`,
          ...wrap(block.text, width - 2).map((line) => `${gutter} ${line}`)
        ];
        return;
      }
      case "system":
        this.#lines = (width) =>
          wrap(`system: ${block.text}`, width).map((l) => c.dim(l));
        return;
      case "attachment":
        this.#lines = (width) => [
          truncateToWidth(c.dim(`+ ${block.label}`), width)
        ];
        return;
      case "notice": {
        const tone = block.tone === "error" ? theme.error : theme.muted;
        this.#lines = (width) => wrap(block.text, width).map((l) => tone(l));
        return;
      }
    }
  }

  render(width: number): string[] {
    return this.#lines(width);
  }

  invalidate(): void {}
}

function wrap(text: string, width: number): string[] {
  return text
    .split("\n")
    .flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
}

export function formatChars(n: number): string {
  return n < 1000 ? `${n} chars` : `${(n / 1000).toFixed(1)}k chars`;
}
