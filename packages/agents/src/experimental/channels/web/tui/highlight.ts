import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { c } from "./theme";
import { sanitize } from "./view";

for (const [name, language] of Object.entries({
  bash,
  css,
  diff,
  javascript,
  json,
  python,
  sql,
  typescript,
  xml,
  yaml
})) {
  hljs.registerLanguage(name, language);
}
hljs.registerAliases(["sh", "shell", "zsh", "console"], {
  languageName: "bash"
});
hljs.registerAliases(["html", "svg"], { languageName: "xml" });
hljs.registerAliases(["jsonc", "json5"], { languageName: "json" });

const styles: Record<string, (s: string) => string> = {
  keyword: c.magenta,
  built_in: c.cyan,
  type: c.cyan,
  literal: c.yellow,
  number: c.yellow,
  string: c.green,
  regexp: c.red,
  symbol: c.yellow,
  comment: (s) => c.italic(c.gray(s)),
  doctag: c.gray,
  meta: c.gray,
  title: c.blue,
  "title.function": c.blue,
  "title.class": c.cyan,
  attr: c.cyan,
  attribute: c.cyan,
  property: c.cyan,
  variable: c.red,
  "template-variable": c.red,
  params: (s) => s,
  section: (s) => c.bold(c.blue(s)),
  name: c.magenta,
  tag: c.gray,
  bullet: c.cyan,
  addition: c.green,
  deletion: c.red,
  emphasis: c.italic,
  strong: c.bold
};

/** Highlighted lines, or the code as is for an unknown language. */
export function highlightCode(code: string, lang?: string): string[] {
  const language = lang && hljs.getLanguage(lang) ? lang : undefined;
  if (!language) return code.split("\n");
  const html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
  return toAnsi(html).split("\n");
}

const highlighted = new WeakMap<object, string[]>();

/** Highlighted JSON, cached per object since cards redraw every frame. */
export function highlightJson(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return toJson(value);
  let lines = highlighted.get(value);
  if (!lines) highlighted.set(value, (lines = toJson(value)));
  return lines;
}

function toJson(value: unknown): string[] {
  return highlightCode(
    sanitize(JSON.stringify(value, null, 2) ?? "undefined"),
    "json"
  );
}

// hljs emits only <span class="hljs-..."> and escaped text. Styles reopen on
// each line so a span crossing a newline still colours both lines.
function toAnsi(html: string): string {
  const stack: ((s: string) => string)[] = [];
  let out = "";
  const emit = (text: string) => {
    out += text
      .split("\n")
      .map((line) =>
        line ? stack.reduceRight((acc, style) => style(acc), line) : line
      )
      .join("\n");
  };
  const tokens = html.split(/(<span class="[^"]*">|<\/span>)/);
  for (const token of tokens) {
    if (token.startsWith("<span")) {
      const scope = /class="hljs-([^" ]+)/.exec(token)?.[1] ?? "";
      const style =
        styles[scope] ?? styles[scope.split(".")[0]] ?? ((s: string) => s);
      stack.push(style);
    } else if (token === "</span>") {
      stack.pop();
    } else if (token) {
      emit(decode(token));
    }
  }
  return out;
}

function decode(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}
