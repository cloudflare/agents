/**
 * Turning a response body into what the model reads: content-type
 * classification, charset decoding, Workers AI Markdown conversion
 * (`env.AI.toMarkdown`), JSON pretty-printing, and the page title.
 * Internal — not an entry point.
 */
import { abortable } from "../abortable";
import type { WebFetchFormat, WebFetchVia } from "./contract";

/**
 * `ConversionResult` as Workers AI Markdown Conversion returns it. Spelled
 * out, with the binding below, so this module depends on the one method it
 * calls rather than on the version of `@cloudflare/workers-types` the host
 * compiles against.
 */
export type AiMarkdownConversionResult = {
  name: string;
  mimeType: string;
  format: "markdown" | "text" | "error";
  tokens?: number;
  data?: string;
  error?: string;
};

/** The subset of the `Ai` binding `web_fetch` uses. */
export interface AiMarkdownBinding {
  toMarkdown(file: {
    name: string;
    blob: Blob;
  }): Promise<AiMarkdownConversionResult | AiMarkdownConversionResult[]>;
}

/** What kind of body a media type names, and so how it's handled. */
export type WebFetchContentKind =
  /** `text/markdown`: passed through. */
  | { kind: "markdown" }
  /** HTML or XHTML: converted to Markdown. */
  | { kind: "html" }
  /** PDF, Office, or OpenDocument: converted to Markdown under `extension`. */
  | { kind: "document"; extension: string }
  /** JSON: pretty-printed. */
  | { kind: "json" }
  /** Other text: passed through. */
  | { kind: "text" }
  /** Images, audio, video, archives, and anything unknown. */
  | { kind: "binary" };

/** Documents Workers AI converts, by media type, with the extension it expects. */
const DOCUMENT_EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel.sheet.macroenabled.12": "xlsm",
  "application/vnd.ms-excel.sheet.binary.macroenabled.12": "xlsb",
  "application/vnd.ms-excel": "xls",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.apple.numbers": "numbers"
};

/** Non-`text/*` types that are text. */
const TEXT_APPLICATION_TYPES = new Set([
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/ecmascript",
  "application/x-yaml",
  "application/yaml",
  "application/toml",
  "application/x-ndjson",
  "application/sql",
  "application/graphql",
  "application/x-sh"
]);

/** Split a `Content-Type` header into its lowercased media type and charset. */
export function parseContentType(header: string | null | undefined): {
  mediaType: string;
  charset?: string;
} {
  if (!header) return { mediaType: "" };
  const [type, ...params] = header.split(";");
  const mediaType = type.trim().toLowerCase();
  for (const param of params) {
    const [name, ...value] = param.split("=");
    if (name.trim().toLowerCase() !== "charset") continue;
    const charset = value
      .join("=")
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .toLowerCase();
    if (charset) return { mediaType, charset };
  }
  return { mediaType };
}

/** Classify a media type into how `web_fetch` handles it. */
export function classifyContentType(mediaType: string): WebFetchContentKind {
  const type = mediaType.toLowerCase();
  if (/^(image|audio|video|font)\//.test(type)) return { kind: "binary" };
  if (type === "text/markdown" || type === "text/x-markdown") {
    return { kind: "markdown" };
  }
  if (type === "text/html" || type === "application/xhtml+xml") {
    return { kind: "html" };
  }
  const extension = DOCUMENT_EXTENSIONS[type];
  if (extension) return { kind: "document", extension };
  if (type === "application/json" || type === "text/json") {
    return { kind: "json" };
  }
  if (type.startsWith("application/") && type.endsWith("+json")) {
    return { kind: "json" };
  }
  if (type.startsWith("text/")) return { kind: "text" };
  if (TEXT_APPLICATION_TYPES.has(type) || type.endsWith("+xml")) {
    return { kind: "text" };
  }
  return { kind: "binary" };
}

/** Whether a kind can be shown as text without conversion. */
export function isTextualKind(kind: WebFetchContentKind): boolean {
  return kind.kind !== "binary" && kind.kind !== "document";
}

/**
 * A media type for a response that didn't send one, from its first bytes:
 * HTML, PDF, binary when it has NUL or many control bytes, otherwise text.
 */
export function sniffContentType(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) return "text/plain";
  const head = bytes.subarray(0, 1024);
  if (startsWithAscii(head, "%PDF-")) return "application/pdf";
  if (head.includes(0) || looksBinary(head)) return "application/octet-stream";
  const text = new TextDecoder().decode(head).trimStart().toLowerCase();
  if (text.startsWith("<!doctype html") || text.startsWith("<html")) {
    return "text/html";
  }
  return "text/plain";
}

/**
 * Binary that happens to have no NUL in its first kilobyte still has
 * control bytes text doesn't (`file` and git use the same test). Tab,
 * line and form feeds, carriage return, and escape are text.
 */
function looksBinary(head: Uint8Array): boolean {
  let control = 0;
  for (const byte of head) {
    if (
      byte < 0x20 &&
      byte !== 9 &&
      byte !== 10 &&
      byte !== 12 &&
      byte !== 13 &&
      byte !== 27
    ) {
      control += 1;
    }
  }
  return control > head.byteLength * 0.05;
}

/**
 * Decode a body. A byte-order mark wins, then the declared charset, then
 * (for HTML) a `<meta charset>` in the first 1024 bytes, then UTF-8. An
 * unknown charset falls back to UTF-8; invalid bytes become U+FFFD.
 */
export function decodeText(
  bytes: Uint8Array,
  charset?: string,
  options: { html?: boolean } = {}
): string {
  const label =
    bomCharset(bytes) ??
    charset ??
    (options.html ? metaCharset(bytes) : undefined) ??
    "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

function bomCharset(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return "utf-8";
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  return undefined;
}

function metaCharset(bytes: Uint8Array): string | undefined {
  // Latin-1 maps every byte to one character, so ASCII markup survives
  // whatever the real encoding is.
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  const match = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i);
  return match?.[1].toLowerCase();
}

/** What to convert, as the source has it after reading the body. */
export interface ConvertBodyInput {
  bytes: Uint8Array<ArrayBuffer>;
  /** Lowercased media type, without parameters. */
  mediaType: string;
  charset?: string;
  format: WebFetchFormat;
  ai: AiMarkdownBinding;
  signal?: AbortSignal;
}

/** The result of {@link convertBody}: content, or why there is none. */
export type ConvertBodyResult =
  | { ok: true; content: string; via: WebFetchVia; title?: string }
  | {
      ok: false;
      code:
        | "web_fetch_unsupported_content_type"
        | "web_fetch_conversion_failed";
      message: string;
      cause?: unknown;
    };

/**
 * Convert a body per the content-type table: Markdown passes through,
 * HTML and documents go through `toMarkdown`, JSON is pretty-printed, other
 * text passes through, binary is unsupported. With `format: "raw"`,
 * textual bodies pass through as served and documents are unsupported.
 * Aborting `signal` rejects with its reason; other failures are results.
 */
export async function convertBody(
  input: ConvertBodyInput
): Promise<ConvertBodyResult> {
  const { bytes, mediaType, charset, format, ai, signal } = input;
  const kind = classifyContentType(mediaType);
  if (!isTextualKind(kind) && (format === "raw" || kind.kind === "binary")) {
    return {
      ok: false,
      code: "web_fetch_unsupported_content_type",
      message: `The response is ${mediaType || "of unknown type"}, which can't be read as text${kind.kind === "document" ? ' with format: "raw"' : ""}.`
    };
  }
  if (kind.kind === "document") {
    const blob = new Blob([bytes], { type: mediaType });
    const converted = await toMarkdown(
      ai,
      { name: `document.${kind.extension}`, blob },
      signal
    );
    if (!converted.ok) return converted;
    return {
      ok: true,
      content: tidyMarkdown(converted.data),
      via: "converted"
    };
  }

  const text = decodeText(bytes, charset, { html: kind.kind === "html" });
  const title =
    kind.kind === "html"
      ? extractHtmlTitle(text)
      : kind.kind === "markdown"
        ? extractMarkdownTitle(text)
        : undefined;
  const withTitle = <T extends object>(result: T) =>
    title ? { ...result, title } : result;

  if (format === "raw") {
    return withTitle({ ok: true as const, content: text, via: "raw" as const });
  }
  switch (kind.kind) {
    case "markdown":
      return withTitle({
        ok: true as const,
        content: text,
        via: "markdown-negotiated" as const
      });
    case "html": {
      const blob = new Blob([text], { type: "text/html" });
      const converted = await toMarkdown(
        ai,
        { name: "page.html", blob },
        signal
      );
      if (!converted.ok) return converted;
      return withTitle({
        ok: true as const,
        content: tidyMarkdown(converted.data),
        via: "converted" as const
      });
    }
    case "json":
      return { ok: true, ...prettyJson(text) };
    default:
      return { ok: true, content: text, via: "text" };
  }
}

/**
 * Trim the padding `toMarkdown` adds: table cells padded to the widest
 * column, delimiter rows of hundreds of dashes, trailing spaces, and runs
 * of blank lines. Fenced code is left byte-for-byte as it was, and only
 * table rows have their inner spaces collapsed, so indented code and
 * nested lists are untouched. Saves roughly a tenth of the characters on
 * table-heavy pages, which is a tenth more page per call.
 */
export function tidyMarkdown(markdown: string): string {
  const out: string[] = [];
  let fence: string | undefined;
  let blankRun = 0;
  for (const line of markdown.split("\n")) {
    // CommonMark: a fence is 3+ backticks or tildes after 0–3 spaces; the
    // closer has the same character, at least as many, and nothing after.
    const run = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence !== undefined) {
      out.push(line);
      if (
        run &&
        run[1][0] === fence[0] &&
        run[1].length >= fence.length &&
        run[2].trim() === ""
      ) {
        fence = undefined;
      }
      continue;
    }
    if (run && !(run[1][0] === "`" && run[2].includes("`"))) {
      fence = run[1];
      blankRun = 0;
      out.push(line);
      continue;
    }
    const tidy = tidyLine(line);
    blankRun = tidy === "" ? blankRun + 1 : 0;
    if (blankRun <= 1) out.push(tidy);
  }
  return out.join("\n");
}

function tidyLine(line: string): string {
  const trimmed = line.trimEnd();
  if (!trimmed.startsWith("|")) return trimmed;
  if (/^\|[\s\-:|]+\|?$/.test(trimmed)) {
    return trimmed.replace(/-{4,}/g, "---").replace(/[ \t]+/g, " ");
  }
  return trimmed.replace(/[ \t]{2,}/g, " ");
}

/** Pretty-print JSON; text that doesn't parse passes through as text. */
function prettyJson(text: string): { content: string; via: WebFetchVia } {
  try {
    return {
      content: JSON.stringify(JSON.parse(text), null, 2),
      via: "json"
    };
  } catch {
    return { content: text, via: "text" };
  }
}

async function toMarkdown(
  ai: AiMarkdownBinding,
  file: { name: string; blob: Blob },
  signal: AbortSignal | undefined
): Promise<
  { ok: true; data: string } | Extract<ConvertBodyResult, { ok: false }>
> {
  if (typeof ai?.toMarkdown !== "function") {
    return {
      ok: false,
      code: "web_fetch_conversion_failed",
      message:
        "The AI binding has no toMarkdown(); pass the Workers AI binding as `binding`."
    };
  }
  signal?.throwIfAborted();
  let response: AiMarkdownConversionResult | AiMarkdownConversionResult[];
  try {
    // The binding takes no signal, so an abort stops waiting for it.
    response = await abortable(ai.toMarkdown(file), signal);
  } catch (cause) {
    if (signal?.aborted) throw signal.reason;
    return {
      ok: false,
      code: "web_fetch_conversion_failed",
      message: `Markdown conversion of ${file.name} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause
    };
  }
  const result = Array.isArray(response) ? response[0] : response;
  if (!result || result.format === "error" || typeof result.data !== "string") {
    return {
      ok: false,
      code: "web_fetch_conversion_failed",
      message: `Markdown conversion of ${file.name} failed${result?.error ? `: ${result.error}` : "."}`
    };
  }
  return { ok: true, data: result.data };
}

/** How far into an HTML page to look for its `<title>`. */
const TITLE_SEARCH_CHARS = 64 * 1024;

/**
 * The text of an HTML page's first `<title>`, looked for in the first
 * 64 KB, with basic entities decoded and whitespace collapsed.
 */
export function extractHtmlTitle(html: string): string | undefined {
  const raw = html
    .slice(0, TITLE_SEARCH_CHARS)
    .match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/i)?.[1];
  const title = raw && decodeEntities(raw).replace(/\s+/g, " ").trim();
  return title || undefined;
}

/** The text of a Markdown document's first `# ` heading. */
export function extractMarkdownTitle(markdown: string): string | undefined {
  const title = markdown.match(/^#[ \t]+(.+?)[ \t#]*$/m)?.[1].trim();
  return title || undefined;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " "
};

/** Decode numeric and the basic named entities; leave the rest as written. */
function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (match, entity: string) => {
      if (entity[0] !== "#")
        return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
      const hex = entity[1] === "x" || entity[1] === "X";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
  );
}

function startsWithAscii(bytes: Uint8Array, prefix: string): boolean {
  if (bytes.byteLength < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix.charCodeAt(i)) return false;
  }
  return true;
}
