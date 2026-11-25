import { describe, expect, it } from "vitest";
import {
  PROVIDER_TOOL_MAX_STRING_LENGTH,
  truncateProviderToolPayloads
} from "../provider-tool-payloads";

const long = "x".repeat(2000);

describe("truncateProviderToolPayloads", () => {
  it("leaves parts the provider did not execute alone", () => {
    const part = { type: "tool-search", input: { q: long } };
    expect(truncateProviderToolPayloads(part)).toBe(part);
  });

  it("cuts long strings in input and output, within the limit", () => {
    const part = {
      type: "tool-code_execution",
      providerExecuted: true,
      input: { code: long },
      output: [long, { nested: long }]
    };
    const result = truncateProviderToolPayloads(part);
    const code = result.input.code;
    expect(code.length).toBeLessThanOrEqual(PROVIDER_TOOL_MAX_STRING_LENGTH);
    expect(code).toContain("[truncated, original length: 2000]");
    expect(result.output[0]).toBe(code);
    expect((result.output[1] as { nested: string }).nested).toBe(code);
  });

  it("keeps strings under an encrypted key whole", () => {
    const part = {
      type: "tool-code_execution",
      providerExecuted: true,
      output: { encryptedContent: long, more: { deep: long } }
    };
    const result = truncateProviderToolPayloads(part);
    expect(result.output.encryptedContent).toBe(long);
    expect(result.output.more.deep.length).toBeLessThanOrEqual(
      PROVIDER_TOOL_MAX_STRING_LENGTH
    );
  });

  it("keeps encrypted subtrees whole", () => {
    const part = {
      type: "tool-x",
      providerExecuted: true,
      output: { encrypted_blob: { inner: long } }
    };
    expect(truncateProviderToolPayloads(part).output.encrypted_blob.inner).toBe(
      long
    );
  });

  it("leaves web_search and web_fetch payloads alone", () => {
    for (const part of [
      { type: "tool-web_search", providerExecuted: true, output: long },
      {
        type: "dynamic-tool",
        toolName: "web_fetch",
        providerExecuted: true,
        output: long
      }
    ]) {
      expect(truncateProviderToolPayloads(part)).toBe(part);
    }
  });

  it("is a no-op on its own output", () => {
    const once = truncateProviderToolPayloads({
      type: "tool-x",
      providerExecuted: true,
      input: long
    });
    expect(truncateProviderToolPayloads(once)).toEqual(once);
  });
});
