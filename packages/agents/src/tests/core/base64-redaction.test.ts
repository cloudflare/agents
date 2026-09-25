import { describe, expect, it } from "vitest";
import {
  redactBase64Payloads,
  redactBase64Replacer
} from "../../core/base64-redaction";

const BASE64 = "A".repeat(4096);

function redact(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, redactBase64Replacer));
}

describe("redactBase64Replacer", () => {
  it("summarizes base64 strings at the threshold", () => {
    expect(redact({ data: BASE64 })).toEqual({
      data: "[base64 data omitted: 4,096 chars, approximately 3,072 bytes]"
    });
  });

  it("accounts for padding in the byte estimate", () => {
    expect(redact(`${"A".repeat(4094)}==`)).toBe(
      "[base64 data omitted: 4,096 chars, approximately 3,070 bytes]"
    );
    expect(redact(`${"A".repeat(4095)}=`)).toBe(
      "[base64 data omitted: 4,096 chars, approximately 3,071 bytes]"
    );
  });

  it("names the media type of data URLs and counts only the encoded part", () => {
    expect(redact(`data:image/jpeg;base64,${BASE64}`)).toBe(
      "[base64 image/jpeg data omitted: 4,096 chars, approximately 3,072 bytes]"
    );
    expect(redact(`data:image/svg+xml;charset=utf-8;base64,${BASE64}`)).toBe(
      "[base64 image/svg+xml data omitted: 4,096 chars, approximately 3,072 bytes]"
    );
  });

  it("leaves strings that are not standard base64 over the threshold", () => {
    const value = {
      short: "A".repeat(4092),
      base64url: `${"A".repeat(4095)}_`,
      unaligned: "A".repeat(4097),
      prose: "ordinary tool text ".repeat(300),
      jwt: `eyJhbGciOiJIUzI1NiJ9.${"A".repeat(4096)}.signature`
    };

    expect(redact(value)).toEqual(value);
  });

  it("redacts browser_screenshot data at any length with the record's media type", () => {
    expect(
      redact({
        type: "browser_screenshot",
        mediaType: "image/png",
        data: "AAAA"
      })
    ).toEqual({
      type: "browser_screenshot",
      mediaType: "image/png",
      data: "[base64 image/png data omitted: 4 chars, approximately 3 bytes]"
    });
  });

  it("only treats a well-formed screenshot record's data field specially", () => {
    // Non-base64 data, a missing media type, and other keys fall back to the
    // ordinary threshold rule.
    const value = {
      invalid: {
        type: "browser_screenshot",
        mediaType: "image/png",
        data: "not base64!"
      },
      untyped: { type: "browser_screenshot", data: "AAAA" },
      otherKey: {
        type: "browser_screenshot",
        mediaType: "image/png",
        thumbnail: "AAAA"
      }
    };

    expect(redact(value)).toEqual(value);
  });

  it("redacts inside arrays and nested records and leaves other values alone", () => {
    expect(
      redact({
        count: 3,
        ok: true,
        missing: null,
        captures: [
          { type: "browser_screenshot", mediaType: "image/webp", data: "AAAA" },
          [BASE64]
        ]
      })
    ).toEqual({
      count: 3,
      ok: true,
      missing: null,
      captures: [
        {
          type: "browser_screenshot",
          mediaType: "image/webp",
          data: "[base64 image/webp data omitted: 4 chars, approximately 3 bytes]"
        },
        ["[base64 data omitted: 4,096 chars, approximately 3,072 bytes]"]
      ]
    });
  });

  it("keeps JSON.stringify semantics for toJSON, dates, maps, and cycles", () => {
    const value = {
      url: new URL("https://example.com/page"),
      when: new Date("2026-01-02T03:04:05.000Z"),
      map: new Map([["key", BASE64]]),
      custom: { toJSON: () => ({ data: BASE64 }) }
    };

    expect(redact(value)).toEqual({
      url: "https://example.com/page",
      when: "2026-01-02T03:04:05.000Z",
      map: {},
      custom: {
        data: "[base64 data omitted: 4,096 chars, approximately 3,072 bytes]"
      }
    });

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => JSON.stringify(circular, redactBase64Replacer)).toThrow(
      TypeError
    );
  });

  it("scans adversarial data-URL-like text in linear time", () => {
    const adversarial = `data:a${";x".repeat(4096)}Q`;

    const started = Date.now();
    expect(redact(adversarial)).toBe(adversarial);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("redactBase64Payloads", () => {
  it("returns a redacted copy without mutating the input", () => {
    const input = {
      screenshot: {
        type: "browser_screenshot",
        mediaType: "image/png",
        data: "AAAA"
      },
      raw: [BASE64]
    };

    expect(redactBase64Payloads(input)).toEqual({
      screenshot: {
        type: "browser_screenshot",
        mediaType: "image/png",
        data: "[base64 image/png data omitted: 4 chars, approximately 3 bytes]"
      },
      raw: ["[base64 data omitted: 4,096 chars, approximately 3,072 bytes]"]
    });
    expect(input.screenshot.data).toBe("AAAA");
    expect(input.raw[0]).toBe(BASE64);
  });

  it("marks cycles but not values shared between siblings", () => {
    const shared = { value: 1 };
    const circular: Record<string, unknown> = { a: shared, b: shared };
    circular.self = circular;

    expect(redactBase64Payloads(circular)).toEqual({
      a: { value: 1 },
      b: { value: 1 },
      self: "[circular reference omitted]"
    });
  });

  it("returns binary and collection values as-is", () => {
    const values = [
      new ArrayBuffer(4),
      new Uint8Array([1, 2, 3]),
      new Date(0),
      new Map([["key", BASE64]]),
      new Set([BASE64])
    ];

    const result = redactBase64Payloads(values) as unknown[];
    values.forEach((value, index) => expect(result[index]).toBe(value));
  });

  it("stops at the depth and node limits", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 25; i++) deep = [deep];
    expect(JSON.stringify(redactBase64Payloads(deep))).toContain(
      "[nested value omitted]"
    );

    const wide = redactBase64Payloads(Array.from({ length: 10_001 }, () => 0));
    expect((wide as unknown[]).at(-1)).toBe("[remaining values omitted]");
  });
});
