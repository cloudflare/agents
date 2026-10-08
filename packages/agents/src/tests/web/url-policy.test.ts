import { describe, expect, it } from "vitest";
import {
  isPrivateOrLocalHost,
  validateRedirect,
  validateUrl,
  validateUrlPolicy,
  type UrlPolicy
} from "../../web/url-policy";

function codeOf(input: string, policy: UrlPolicy = {}) {
  const result = validateUrl(input, policy);
  return result.ok ? "ok" : result.code;
}

describe("validateUrl", () => {
  it("accepts public http and https URLs and strips the fragment", () => {
    expect(validateUrl("https://example.com/a?b=c#top")).toEqual({
      ok: true,
      url: new URL("https://example.com/a?b=c")
    });
    expect(codeOf("http://example.com")).toBe("ok");
    expect(codeOf("http://8.8.8.8/")).toBe("ok");
    expect(codeOf("http://[2606:4700::1111]/")).toBe("ok");
    expect(codeOf("http://172.32.0.1/")).toBe("ok");
    expect(codeOf("http://localhost.example.com/")).toBe("ok");
  });

  it("rejects what isn't an absolute URL", () => {
    expect(codeOf("not a url")).toBe("invalid_url");
    expect(codeOf("/relative/path")).toBe("invalid_url");
    expect(codeOf(42 as unknown as string)).toBe("invalid_url");
  });

  it("rejects schemes other than http and https", () => {
    for (const url of [
      "ftp://example.com/",
      "file:///etc/passwd",
      "data:,hi"
    ]) {
      expect(codeOf(url), url).toBe("unsupported_protocol");
    }
  });

  it("rejects userinfo", () => {
    expect(codeOf("https://user:pass@example.com/")).toBe("credentials");
    expect(codeOf("https://user@example.com/")).toBe("credentials");
  });

  it("enforces the length limit, 2000 by default", () => {
    const base = "https://example.com/";
    expect(codeOf(base + "a".repeat(2000 - base.length))).toBe("ok");
    expect(codeOf(base + "a".repeat(2001 - base.length))).toBe("too_long");
    expect(codeOf(`${base}abcdef`, { maxUrlLength: 20 })).toBe("too_long");
  });

  it("checks blockedHosts, then allowedHosts, then the private-host rule", () => {
    const policy = {
      allowedHosts: ["*.example.com", "localhost"],
      blockedHosts: ["secret.example.com"]
    };
    expect(codeOf("https://a.b.example.com/", policy)).toBe("ok");
    expect(codeOf("https://secret.example.com/", policy)).toBe("blocked_host");
    expect(codeOf("https://example.com/", policy)).toBe("host_not_allowed");
    expect(codeOf("https://badexample.com/", policy)).toBe("host_not_allowed");
    expect(codeOf("http://localhost/", policy)).toBe("private_host");
    expect(codeOf("https://example.org/", { allowedHosts: [] })).toBe("ok");
    expect(codeOf("https://example.org/", { allowedHosts: ["*"] })).toBe("ok");
  });

  it("matches patterns however the host or pattern is spelled", () => {
    expect(
      codeOf("https://xn--bcher-kva.de/", { blockedHosts: ["bücher.de"] })
    ).toBe("blocked_host");
    expect(
      codeOf("https://EXAMPLE.com./", { blockedHosts: ["Example.COM"] })
    ).toBe("blocked_host");
    expect(
      codeOf("http://1572395042/", { blockedHosts: ["93.184.216.34"] })
    ).toBe("blocked_host");
    expect(codeOf("http://[0:0::1]/", { blockedHosts: ["[::1]"] })).toBe(
      "blocked_host"
    );
  });

  it("ignores malformed patterns rather than throwing", () => {
    const policy = {
      allowedHosts: [
        7,
        "",
        "exa*mple.com",
        "example.com"
      ] as unknown as string[]
    };
    expect(codeOf("https://example.com/", policy)).toBe("ok");
    expect(codeOf("https://example.org/", policy)).toBe("host_not_allowed");
  });

  it.each([
    ["loopback", "http://127.0.0.1:8787/"],
    ["private IPv4", "http://192.168.1.1/"],
    ["CGNAT", "http://100.64.0.1/"],
    ["link-local metadata", "http://169.254.169.254/latest/meta-data/"],
    ["multicast", "http://224.0.0.1/"],
    ["IPv6 loopback", "http://[::1]/"],
    ["IPv6 unique local", "http://[fd12:3456::1]/"],
    ["IPv4-mapped loopback", "http://[::ffff:127.0.0.1]/"],
    ["IPv4-mapped metadata, hex", "http://[::ffff:a9fe:a9fe]/"],
    ["decimal loopback", "http://2130706433/"],
    ["hex and short-form loopback", "http://0x7f.1/"],
    ["localhost with a trailing dot", "http://LOCALHOST./"],
    ["a .localhost name", "http://app.localhost/"],
    ["a .internal name", "http://metadata.google.internal/"]
  ])("rejects %s unless allowPrivateHosts", (_, url) => {
    expect(codeOf(url)).toBe("private_host");
    expect(codeOf(url, { allowPrivateHosts: true })).toBe("ok");
  });

  it("names the canonical host in its messages", () => {
    const result = validateUrl("http://[::ffff:127.0.0.1]/");
    expect(result.ok ? "" : result.message).toContain("[::ffff:7f00:1]");
  });
});

describe("validateRedirect", () => {
  const from = new URL("https://example.com/a/b");

  it("resolves relative locations against the redirecting URL", () => {
    const result = validateRedirect("../c#frag", from);
    expect(result.ok && result.url.href).toBe("https://example.com/c");
  });

  it("re-checks the target against the policy", () => {
    expect(validateRedirect("http://0x7f000001/", from)).toMatchObject({
      ok: false,
      code: "private_host"
    });
    expect(validateRedirect("file:///etc/passwd", from)).toMatchObject({
      ok: false,
      code: "unsupported_protocol"
    });
    expect(
      validateRedirect("https://other.org/", from, {
        allowedHosts: ["example.com"]
      })
    ).toMatchObject({ ok: false, code: "host_not_allowed" });
  });

  it("rejects an unparseable location", () => {
    expect(validateRedirect("http://[bad", from)).toMatchObject({
      ok: false,
      code: "invalid_url"
    });
  });
});

describe("validateUrlPolicy", () => {
  it("accepts valid policies", () => {
    expect(() =>
      validateUrlPolicy({
        allowedHosts: ["example.com", "*.example.org", "*", "bücher.de"],
        blockedHosts: ["[::1]", "10.0.0.1"],
        maxUrlLength: 100
      })
    ).not.toThrow();
  });

  it.each([
    { maxUrlLength: 0 },
    { maxUrlLength: 1.5 },
    { allowedHosts: "example.com" as unknown as string[] },
    { allowedHosts: ["a*.com"] },
    { allowedHosts: ["*."] },
    { allowedHosts: ["example.com:8080"] },
    { allowedHosts: ["example.com/path"] },
    { blockedHosts: ["https://example.com"] },
    { blockedHosts: ["1.2.3.256"] }
  ])("throws RangeError for %j", (policy) => {
    expect(() => validateUrlPolicy(policy)).toThrow(RangeError);
  });
});

describe("isPrivateOrLocalHost", () => {
  it("refuses a numeric host the URL parser didn't canonicalise", () => {
    expect(isPrivateOrLocalHost("2130706433")).toBe(true);
    expect(isPrivateOrLocalHost("0x7f.1")).toBe(true);
    expect(isPrivateOrLocalHost("example.com")).toBe(false);
  });
});
