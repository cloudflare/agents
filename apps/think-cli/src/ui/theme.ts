/**
 * Theme — pi dark.json color palette.
 * Credit: https://github.com/badlogic/pi-mono (MIT)
 */

import { Chalk } from "chalk";
import type { MarkdownTheme, EditorTheme } from "@mariozechner/pi-tui";

const chalk = new Chalk({ level: 3 });

// Backgrounds
export const userMsgBg = (t: string) => chalk.bgHex("#343541")(t);
export const toolPendBg = (t: string) => chalk.bgHex("#282832")(t);
export const toolOkBg = (t: string) => chalk.bgHex("#283228")(t);
export const toolErrBg = (t: string) => chalk.bgHex("#3c2828")(t);

// Foreground
export const fg = {
  accent: (t: string) => chalk.hex("#8abeb7")(t),
  border: (t: string) => chalk.hex("#5f87ff")(t),
  borderMuted: (t: string) => chalk.hex("#505050")(t),
  success: (t: string) => chalk.hex("#b5bd68")(t),
  error: (t: string) => chalk.hex("#cc6666")(t),
  muted: (t: string) => chalk.hex("#808080")(t),
  dim: (t: string) => chalk.hex("#666666")(t),
};

export const mdTheme: MarkdownTheme = {
  heading: (t: string) => chalk.hex("#f0c674")(t),
  link: (t: string) => chalk.hex("#81a2be")(t),
  linkUrl: (t: string) => fg.dim(t),
  code: (t: string) => fg.accent(t),
  codeBlock: (t: string) => chalk.hex("#b5bd68")(t),
  codeBlockBorder: (t: string) => fg.muted(t),
  quote: (t: string) => fg.muted(t),
  quoteBorder: (t: string) => fg.muted(t),
  hr: (t: string) => fg.muted(t),
  listBullet: (t: string) => fg.accent(t),
  bold: (t: string) => chalk.bold(t),
  italic: (t: string) => chalk.italic(t),
  strikethrough: (t: string) => chalk.strikethrough(t),
  underline: (t: string) => chalk.underline(t),
};

export const editorTheme: EditorTheme = {
  borderColor: (t: string) => fg.border(t),
  selectList: {
    selectedPrefix: (t: string) => fg.accent(t),
    selectedText: (t: string) => chalk.bold(t),
    description: (t: string) => fg.dim(t),
    scrollInfo: (t: string) => fg.dim(t),
    noMatch: (t: string) => fg.dim(t),
  },
};

export { chalk };
