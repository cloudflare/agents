import {
  type Component,
  Editor,
  type Focusable,
  Input,
  matchesKey,
  type TUI
} from "@earendil-works/pi-tui";
import type { Json, ToolPart } from "../../../protocol";
import { highlightJson } from "../highlight";
import { c, editorTheme, theme } from "../theme";
import { parseOutput } from "../view";
import { card } from "./blocks";

export type ClientToolAnswer =
  | { ok: true; output: Json }
  | { ok: false; errorText: string };

/** Lets a person stand in for a client tool: type its output or an error. */
export class ClientToolModal implements Component, Focusable {
  readonly #editor: Editor;
  #focused = false;

  constructor(
    tui: TUI,
    readonly part: ToolPart,
    readonly answer: (answer: ClientToolAnswer) => void,
    readonly ignore: () => void
  ) {
    this.#editor = new Editor(tui, editorTheme);
    this.#editor.onSubmit = (text) => {
      if (text) answer({ ok: true, output: parseOutput(text) });
    };
  }

  get focused(): boolean {
    return this.#focused;
  }

  set focused(value: boolean) {
    this.#focused = value;
    this.#editor.focused = value;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) this.ignore();
    else if (matchesKey(data, "ctrl+x")) {
      this.answer({ ok: false, errorText: this.#editor.getText().trim() });
    } else this.#editor.handleInput(data);
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - 4);
    const body = [
      c.dim("input"),
      ...(this.part.input === undefined ? [] : highlightJson(this.part.input)),
      "",
      c.dim("output: JSON, or text sent as a string"),
      ...this.#editor.render(inner),
      c.dim(
        "Enter send · Shift+Enter new line · Ctrl+X send as an error · Esc ignore"
      )
    ];
    return card(
      `◆ ${c.bold(this.part.title ?? this.part.toolName)}`,
      theme.warn("your client's result"),
      body,
      width,
      theme.warn
    );
  }

  invalidate(): void {
    this.#editor.invalidate();
  }
}

/** Asks for a reason, then denies the approval with it. */
export class ReasonModal implements Component, Focusable {
  readonly #input = new Input({ prompt: "› " });
  #focused = false;

  constructor(
    readonly part: ToolPart,
    deny: (reason: string) => void,
    readonly close: () => void
  ) {
    this.#input.onSubmit = (reason) => deny(reason.trim());
    this.#input.onEscape = close;
  }

  get focused(): boolean {
    return this.#focused;
  }

  set focused(value: boolean) {
    this.#focused = value;
    this.#input.focused = value;
  }

  handleInput(data: string): void {
    this.#input.handleInput(data);
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - 4);
    return card(
      `Deny ${c.bold(this.part.title ?? this.part.toolName)}`,
      "",
      [
        c.dim("reason"),
        ...this.#input.render(inner),
        c.dim("Enter deny · Esc back")
      ],
      width,
      theme.error
    );
  }

  invalidate(): void {
    this.#input.invalidate();
  }
}
