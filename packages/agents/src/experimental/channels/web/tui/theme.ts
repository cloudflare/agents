import type { EditorTheme, MarkdownTheme } from "@earendil-works/pi-tui";

const sgr =
  (open: string, close: string) =>
  (text: string): string =>
    `\x1b[${open}m${text}\x1b[${close}m`;

export const c = {
  bold: sgr("1", "22"),
  dim: sgr("2", "22"),
  italic: sgr("3", "23"),
  underline: sgr("4", "24"),
  strike: sgr("9", "29"),
  inverse: sgr("7", "27"),
  red: sgr("31", "39"),
  green: sgr("32", "39"),
  yellow: sgr("33", "39"),
  blue: sgr("34", "39"),
  magenta: sgr("35", "39"),
  cyan: sgr("36", "39"),
  gray: sgr("90", "39")
};

export const theme = {
  you: (s: string) => c.bold(c.cyan(s)),
  other: (s: string) => c.bold(c.magenta(s)),
  border: c.gray,
  muted: c.gray,
  accent: c.cyan,
  ok: c.green,
  warn: c.yellow,
  error: c.red
};

export const markdownTheme: MarkdownTheme = {
  heading: (s) => c.bold(c.cyan(s)),
  link: c.blue,
  linkUrl: c.gray,
  code: c.yellow,
  codeBlock: (s) => s,
  codeBlockBorder: c.gray,
  quote: c.italic,
  quoteBorder: c.gray,
  hr: c.gray,
  listBullet: c.cyan,
  bold: c.bold,
  italic: c.italic,
  strikethrough: c.strike,
  underline: c.underline
};

export const editorTheme: EditorTheme = {
  borderColor: c.gray,
  selectList: {
    selectedPrefix: c.cyan,
    selectedText: c.cyan,
    description: c.gray,
    scrollInfo: c.gray,
    noMatch: c.gray
  }
};
