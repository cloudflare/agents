import { describe, expect, it } from "vitest";
import {
  classifyContentType,
  convertBody,
  decodeText,
  extractHtmlTitle,
  extractMarkdownTitle,
  parseContentType,
  sniffContentType,
  tidyMarkdown,
  type AiMarkdownBinding,
  type ConvertBodyInput
} from "../../../web/fetch/convert";
import { fakeAi } from "./helpers";

const encode = (text: string) => new TextEncoder().encode(text);

function convert(
  body: string | Uint8Array<ArrayBuffer>,
  mediaType: string,
  extra: Partial<ConvertBodyInput> = {}
) {
  const fake = fakeAi();
  const result = convertBody({
    bytes: typeof body === "string" ? encode(body) : body,
    mediaType,
    format: "auto",
    ai: fake.binding as unknown as AiMarkdownBinding,
    ...extra
  });
  return { result, calls: fake.calls };
}

describe("convertBody, format auto", () => {
  it("passes text/markdown through as markdown-negotiated", async () => {
    const { result, calls } = convert("# Title\n\nBody", "text/markdown");
    expect(await result).toEqual({
      ok: true,
      content: "# Title\n\nBody",
      via: "markdown-negotiated",
      title: "Title"
    });
    expect(calls).toEqual([]);
  });

  it.each(["text/html", "application/xhtml+xml"])(
    "converts %s with toMarkdown as page.html",
    async (type) => {
      const html = "<html><head><title>Page</title></head><p>x</p></html>";
      const { result, calls } = convert(html, type);
      expect(await result).toEqual({
        ok: true,
        content: "# Converted page.html",
        via: "converted",
        title: "Page"
      });
      expect(calls).toEqual([
        { name: "page.html", type: "text/html", text: html }
      ]);
    }
  );

  it.each([
    ["application/pdf", "pdf"],
    [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "docx"
    ],
    [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "xlsx"
    ],
    ["application/vnd.ms-excel.sheet.macroenabled.12", "xlsm"],
    ["application/vnd.ms-excel.sheet.binary.macroenabled.12", "xlsb"],
    ["application/vnd.ms-excel", "xls"],
    ["application/vnd.oasis.opendocument.spreadsheet", "ods"],
    ["application/vnd.oasis.opendocument.text", "odt"],
    ["application/vnd.apple.numbers", "numbers"]
  ])("converts %s with toMarkdown as document.%s", async (type, extension) => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff]);
    const { result, calls } = convert(bytes, type);
    expect(await result).toEqual({
      ok: true,
      content: `# Converted document.${extension}`,
      via: "converted"
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: `document.${extension}`, type });
  });

  it.each(["application/json", "application/ld+json", "text/json"])(
    "pretty-prints %s",
    async (type) => {
      const { result } = convert('{"a":1,"b":[true,null]}', type);
      expect(await result).toEqual({
        ok: true,
        content: '{\n  "a": 1,\n  "b": [\n    true,\n    null\n  ]\n}',
        via: "json"
      });
    }
  );

  it("passes invalid JSON through as text", async () => {
    const { result } = convert("{not json", "application/json");
    expect(await result).toEqual({
      ok: true,
      content: "{not json",
      via: "text"
    });
  });

  it.each([
    "text/plain",
    "text/csv",
    "text/xml",
    "text/css",
    "application/xml",
    "application/rss+xml",
    "application/atom+xml",
    "application/javascript",
    "application/x-yaml",
    "application/yaml"
  ])("passes %s through as text", async (type) => {
    const { result, calls } = convert("line 1\nline 2", type);
    expect(await result).toEqual({
      ok: true,
      content: "line 1\nline 2",
      via: "text"
    });
    expect(calls).toEqual([]);
  });

  it.each([
    "image/png",
    "image/svg+xml",
    "audio/mpeg",
    "video/mp4",
    "application/octet-stream",
    "application/zip",
    "font/woff2"
  ])("rejects %s as unsupported", async (type) => {
    const { result, calls } = convert(new Uint8Array([1, 2, 3]), type);
    expect(await result).toMatchObject({
      ok: false,
      code: "web_fetch_unsupported_content_type"
    });
    expect(calls).toEqual([]);
  });

  it("decodes the declared charset", async () => {
    const { result } = convert(
      new Uint8Array([0x6e, 0x61, 0xef, 0x76, 0x65]),
      "text/plain",
      {
        charset: "iso-8859-1"
      }
    );
    expect(await result).toMatchObject({ content: "naïve" });
  });
});

describe("convertBody, format raw", () => {
  it.each([
    ["text/html", "<title>T</title><p>x</p>", "T"],
    ["text/markdown", "# M\n", "M"],
    ["application/json", '{"a":1}', undefined],
    ["text/plain", "plain", undefined],
    ["application/xml", "<a/>", undefined]
  ])("passes %s through as raw", async (type, body, title) => {
    const { result, calls } = convert(body, type, { format: "raw" });
    expect(await result).toEqual({
      ok: true,
      content: body,
      via: "raw",
      ...(title ? { title } : {})
    });
    expect(calls).toEqual([]);
  });

  it.each(["application/pdf", "image/png", "application/octet-stream"])(
    "rejects %s as unsupported",
    async (type) => {
      const { result, calls } = convert(new Uint8Array([1]), type, {
        format: "raw"
      });
      expect(await result).toMatchObject({
        ok: false,
        code: "web_fetch_unsupported_content_type"
      });
      expect(calls).toEqual([]);
    }
  );
});

describe("convertBody, conversion failures", () => {
  const html = encode("<p>x</p>");

  it("fails when the result is an error", async () => {
    const { binding: ai } = fakeAi((call) => ({
      name: call.name,
      mimeType: "text/html",
      format: "error",
      error: "unsupported"
    }));
    const result = await convertBody({
      bytes: html,
      mediaType: "text/html",
      format: "auto",
      ai: ai as unknown as AiMarkdownBinding
    });
    expect(result).toMatchObject({
      ok: false,
      code: "web_fetch_conversion_failed",
      message: "Markdown conversion of page.html failed: unsupported"
    });
  });

  it("fails when toMarkdown throws", async () => {
    const cause = new Error("upstream 500");
    const ai: AiMarkdownBinding = {
      toMarkdown: () => Promise.reject(cause)
    };
    const result = await convertBody({
      bytes: html,
      mediaType: "text/html",
      format: "auto",
      ai
    });
    expect(result).toMatchObject({
      ok: false,
      code: "web_fetch_conversion_failed",
      cause
    });
  });

  it("fails when the binding has no toMarkdown", async () => {
    const result = await convertBody({
      bytes: html,
      mediaType: "text/html",
      format: "auto",
      ai: {} as AiMarkdownBinding
    });
    expect(result).toMatchObject({
      ok: false,
      code: "web_fetch_conversion_failed"
    });
  });

  it("reads the first result of an array", async () => {
    const { binding: ai } = fakeAi((call) => [
      {
        name: call.name,
        mimeType: "text/html",
        format: "markdown",
        tokens: 1,
        data: "from array"
      }
    ]);
    const result = await convertBody({
      bytes: html,
      mediaType: "text/html",
      format: "auto",
      ai: ai as unknown as AiMarkdownBinding
    });
    expect(result).toMatchObject({ ok: true, content: "from array" });
  });
});

describe("classifyContentType", () => {
  it("classifies unknown types as binary", () => {
    expect(classifyContentType("")).toEqual({ kind: "binary" });
    expect(classifyContentType("application/x-whatever")).toEqual({
      kind: "binary"
    });
  });
});

describe("parseContentType", () => {
  it("splits media type and charset", () => {
    expect(
      parseContentType('Text/HTML; Charset="ISO-8859-1"; foo=bar')
    ).toEqual({ mediaType: "text/html", charset: "iso-8859-1" });
    expect(parseContentType("application/json")).toEqual({
      mediaType: "application/json"
    });
    expect(parseContentType(null)).toEqual({ mediaType: "" });
  });
});

describe("decodeText", () => {
  it("prefers a byte-order mark to the declared charset", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0xc3, 0xa9]);
    expect(decodeText(bytes, "iso-8859-1")).toBe("é");
  });

  it("decodes UTF-16 with a BOM", () => {
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x68, 0x00]))).toBe("h");
  });

  it("falls back to UTF-8 for an unknown charset", () => {
    expect(decodeText(encode("é"), "x-made-up")).toBe("é");
  });

  it("reads <meta charset> for HTML without a declared charset", () => {
    const bytes = new Uint8Array([
      ...encode('<meta charset="windows-1252"><p>'),
      0x93,
      0x94
    ]);
    expect(decodeText(bytes, undefined, { html: true })).toContain("“”");
    expect(decodeText(bytes, "utf-8", { html: true })).not.toContain("“”");
  });
});

describe("sniffContentType", () => {
  it("recognises HTML, PDF, binary, and text", () => {
    expect(sniffContentType(encode("  <!DOCTYPE html><html>"))).toBe(
      "text/html"
    );
    expect(sniffContentType(encode("%PDF-1.7"))).toBe("application/pdf");
    expect(sniffContentType(new Uint8Array([1, 0, 2]))).toBe(
      "application/octet-stream"
    );
    expect(sniffContentType(encode("hello"))).toBe("text/plain");
    expect(sniffContentType(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBe(
      "text/plain"
    );
    expect(
      sniffContentType(new Uint8Array([0x1f, 0x8b, 0x08, 0x08, 0x01, 0x02]))
    ).toBe("application/octet-stream");
    expect(sniffContentType(encode("\x1b[31mred\x1b[0m\ttab\r\n"))).toBe(
      "text/plain"
    );
    expect(sniffContentType(new Uint8Array(0))).toBe("text/plain");
  });
});

describe("titles", () => {
  it("takes the first <title> in the first 64 KB, decoding entities", () => {
    expect(
      extractHtmlTitle(
        "<head><title>\n  A &amp; B &#8212; C&#x21;\n</title></head><svg><title>icon</title></svg>"
      )
    ).toBe("A & B — C!");
    expect(extractHtmlTitle("<p>no title</p>")).toBeUndefined();
    expect(extractHtmlTitle("<title>  </title>")).toBeUndefined();
    expect(
      extractHtmlTitle(`${" ".repeat(70_000)}<title>late</title>`)
    ).toBeUndefined();
  });

  it("takes the first # heading of Markdown", () => {
    expect(extractMarkdownTitle("intro\n## Sub\n# Main #\n# Second")).toBe(
      "Main"
    );
    expect(extractMarkdownTitle("no heading")).toBeUndefined();
  });
});

describe("tidyMarkdown", () => {
  it("collapses table padding and blank-line runs", () => {
    const padded = [
      "# Title   ",
      "",
      "",
      "",
      "| Name          | Value        |",
      "| ------------- | ------------ |",
      "| a             | 1            |",
      "",
      "    indented code   stays",
      "- item"
    ].join("\n");
    expect(tidyMarkdown(padded)).toBe(
      [
        "# Title",
        "",
        "| Name | Value |",
        "| --- | --- |",
        "| a | 1 |",
        "",
        "    indented code   stays",
        "- item"
      ].join("\n")
    );
  });

  it("leaves fenced code byte-for-byte alone", () => {
    const fenced = [
      "Intro   ",
      "```text",
      "first  ",
      "",
      "",
      "",
      "| a    | b    |",
      "```",
      "after   ",
      "",
      "",
      "",
      "~~~~",
      "```",
      "still   inside  ",
      "~~~~",
      "end"
    ].join("\n");
    expect(tidyMarkdown(fenced)).toBe(
      [
        "Intro",
        "```text",
        "first  ",
        "",
        "",
        "",
        "| a    | b    |",
        "```",
        "after",
        "",
        "~~~~",
        "```",
        "still   inside  ",
        "~~~~",
        "end"
      ].join("\n")
    );
  });

  it("recognises a fence whose info string has a Unicode line separator", () => {
    const fenced = "```js\u2028demo\nconst x = 1;  \n```";
    expect(tidyMarkdown(fenced)).toBe(fenced);
  });

  it("closes a fence only on a bare closing run", () => {
    const fenced = [
      "```js",
      "```not-a-close",
      "| a    | b    |",
      "```  ",
      "| a    | b    |",
      "\t```",
      "x  "
    ].join("\n");
    expect(tidyMarkdown(fenced)).toBe(
      [
        "```js",
        "```not-a-close",
        "| a    | b    |",
        "```  ",
        "| a | b |",
        "\t```",
        "x"
      ].join("\n")
    );
  });

  it("leaves compact markdown alone", () => {
    const compact = "# T\n\nSome *text*.\n\n```js\nconst  x = 1;\n```\n";
    expect(tidyMarkdown(compact)).toBe(compact);
  });
});
