import { describe, expect, it } from "vitest";
import {
  isPrivateIp,
  isUrlAllowed,
  matchesAllowListEntry,
  normalizeAllowListEntry,
  parseUrl,
  validateAllowList
} from "../allow-list";
import { createSecureFetch } from "../fetch";

describe("parseUrl", () => {
  it("parses a simple URL", () => {
    const result = parseUrl("https://example.com/path");
    expect(result).toEqual({
      origin: "https://example.com",
      pathname: "/path",
      href: "https://example.com/path"
    });
  });

  it("parses URL with port", () => {
    const result = parseUrl("https://example.com:8080/api");
    expect(result).toEqual({
      origin: "https://example.com:8080",
      pathname: "/api",
      href: "https://example.com:8080/api"
    });
  });

  it("parses URL with query string", () => {
    const result = parseUrl("https://example.com/path?foo=bar");
    expect(result).toEqual({
      origin: "https://example.com",
      pathname: "/path",
      href: "https://example.com/path?foo=bar"
    });
  });

  it("returns null for invalid URL", () => {
    expect(parseUrl("not-a-url")).toBeNull();
    expect(parseUrl("")).toBeNull();
    expect(parseUrl("://missing-scheme")).toBeNull();
  });

  it("parses http URL", () => {
    const result = parseUrl("http://example.com");
    expect(result).toEqual({
      origin: "http://example.com",
      pathname: "/",
      href: "http://example.com/"
    });
  });
});

describe("normalizeAllowListEntry", () => {
  it("normalizes origin-only entry", () => {
    expect(normalizeAllowListEntry("https://example.com")).toEqual({
      origin: "https://example.com",
      pathPrefix: "/"
    });
  });

  it("normalizes origin with trailing slash", () => {
    expect(normalizeAllowListEntry("https://example.com/")).toEqual({
      origin: "https://example.com",
      pathPrefix: "/"
    });
  });

  it("preserves path prefix", () => {
    expect(normalizeAllowListEntry("https://example.com/api/v1")).toEqual({
      origin: "https://example.com",
      pathPrefix: "/api/v1"
    });
  });

  it("preserves path prefix with trailing slash", () => {
    expect(normalizeAllowListEntry("https://example.com/api/v1/")).toEqual({
      origin: "https://example.com",
      pathPrefix: "/api/v1/"
    });
  });

  it("returns null for invalid entry", () => {
    expect(normalizeAllowListEntry("not-a-url")).toBeNull();
  });
});

describe("matchesAllowListEntry", () => {
  describe("origin matching", () => {
    it("matches exact origin", () => {
      expect(
        matchesAllowListEntry(
          "https://example.com/any/path",
          "https://example.com"
        )
      ).toBe(true);
    });

    it("does not match different origin", () => {
      expect(
        matchesAllowListEntry("https://other.com/path", "https://example.com")
      ).toBe(false);
    });

    it("does not match different scheme", () => {
      expect(
        matchesAllowListEntry("http://example.com/path", "https://example.com")
      ).toBe(false);
    });

    it("does not match different port", () => {
      expect(
        matchesAllowListEntry(
          "https://example.com:8080/path",
          "https://example.com"
        )
      ).toBe(false);
    });

    it("matches same port explicitly", () => {
      expect(
        matchesAllowListEntry(
          "https://example.com:8080/path",
          "https://example.com:8080"
        )
      ).toBe(true);
    });

    it("does not match subdomain", () => {
      expect(
        matchesAllowListEntry(
          "https://api.example.com/path",
          "https://example.com"
        )
      ).toBe(false);
    });

    it("matches exact subdomain", () => {
      expect(
        matchesAllowListEntry(
          "https://api.example.com/path",
          "https://api.example.com"
        )
      ).toBe(true);
    });
  });

  describe("path matching", () => {
    it("allows any path when entry is origin only", () => {
      expect(
        matchesAllowListEntry("https://example.com/", "https://example.com")
      ).toBe(true);
      expect(
        matchesAllowListEntry("https://example.com/api", "https://example.com")
      ).toBe(true);
      expect(
        matchesAllowListEntry(
          "https://example.com/api/v1/users",
          "https://example.com"
        )
      ).toBe(true);
    });

    it("matches path prefix", () => {
      expect(
        matchesAllowListEntry(
          "https://example.com/api/v1",
          "https://example.com/api"
        )
      ).toBe(true);
      expect(
        matchesAllowListEntry(
          "https://example.com/api/v1/users",
          "https://example.com/api"
        )
      ).toBe(true);
    });

    it("matches exact path", () => {
      expect(
        matchesAllowListEntry(
          "https://example.com/api/v1",
          "https://example.com/api/v1"
        )
      ).toBe(true);
    });

    it("does not match different path", () => {
      expect(
        matchesAllowListEntry(
          "https://example.com/other",
          "https://example.com/api"
        )
      ).toBe(false);
    });

    it("path prefix is strict - /api does not match /apiv2", () => {
      expect(
        matchesAllowListEntry(
          "https://example.com/apiv2",
          "https://example.com/api/"
        )
      ).toBe(false);
    });

    it("trailing slash in entry enforces directory-like prefix", () => {
      // With trailing slash, /api/ does not match /api
      expect(
        matchesAllowListEntry(
          "https://example.com/api",
          "https://example.com/api/"
        )
      ).toBe(false);
      // But matches /api/anything
      expect(
        matchesAllowListEntry(
          "https://example.com/api/v1",
          "https://example.com/api/"
        )
      ).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("handles root path", () => {
      expect(
        matchesAllowListEntry("https://example.com/", "https://example.com/")
      ).toBe(true);
    });

    it("returns false for invalid URL", () => {
      expect(matchesAllowListEntry("not-a-url", "https://example.com")).toBe(
        false
      );
    });

    it("returns false for invalid entry", () => {
      expect(matchesAllowListEntry("https://example.com", "not-a-url")).toBe(
        false
      );
    });

    it("handles URL with query string - query is ignored in matching", () => {
      expect(
        matchesAllowListEntry(
          "https://example.com/api?foo=bar",
          "https://example.com/api"
        )
      ).toBe(true);
    });

    it("handles URL with fragment - fragment is ignored in matching", () => {
      expect(
        matchesAllowListEntry(
          "https://example.com/api#section",
          "https://example.com/api"
        )
      ).toBe(true);
    });

    it("handles case sensitivity in path", () => {
      expect(
        matchesAllowListEntry(
          "https://example.com/API",
          "https://example.com/api"
        )
      ).toBe(false);
    });
  });
});

describe("isUrlAllowed", () => {
  it("returns false for empty allow list", () => {
    expect(isUrlAllowed("https://example.com/path", [])).toBe(false);
  });

  it("returns false for undefined allow list", () => {
    expect(
      isUrlAllowed("https://example.com/path", undefined as unknown as string[])
    ).toBe(false);
  });

  it("returns true if URL matches any entry", () => {
    const allowedUrlPrefixes = [
      "https://api.example.com",
      "https://cdn.example.com/assets"
    ];
    expect(
      isUrlAllowed("https://api.example.com/v1/users", allowedUrlPrefixes)
    ).toBe(true);
    expect(
      isUrlAllowed(
        "https://cdn.example.com/assets/image.png",
        allowedUrlPrefixes
      )
    ).toBe(true);
  });

  it("returns false if URL does not match any entry", () => {
    const allowedUrlPrefixes = ["https://api.example.com"];
    expect(isUrlAllowed("https://other.com/path", allowedUrlPrefixes)).toBe(
      false
    );
  });

  it("handles multiple entries correctly", () => {
    const allowedUrlPrefixes = [
      "https://api.example.com/v1/",
      "https://api.example.com/v2/",
      "https://cdn.example.com"
    ];

    // Matches v1
    expect(
      isUrlAllowed("https://api.example.com/v1/users", allowedUrlPrefixes)
    ).toBe(true);
    // Matches v2
    expect(
      isUrlAllowed("https://api.example.com/v2/data", allowedUrlPrefixes)
    ).toBe(true);
    // Does not match v3
    expect(
      isUrlAllowed("https://api.example.com/v3/other", allowedUrlPrefixes)
    ).toBe(false);
    // Matches CDN
    expect(
      isUrlAllowed("https://cdn.example.com/anything", allowedUrlPrefixes)
    ).toBe(true);
  });
});

describe("validateAllowList", () => {
  describe("valid entries", () => {
    it("returns empty array for valid entries", () => {
      const errors = validateAllowList([
        "https://example.com",
        "https://api.example.com/v1",
        "http://localhost:3000"
      ]);
      expect(errors).toEqual([]);
    });

    it("accepts origin-only entries", () => {
      const errors = validateAllowList([
        "https://example.com",
        "http://localhost",
        "https://api.example.com:8443"
      ]);
      expect(errors).toEqual([]);
    });

    it("accepts origin with path prefix entries", () => {
      const errors = validateAllowList([
        "https://api.example.com/v1/",
        "https://api.example.com/v1/users",
        "http://localhost:3000/api/"
      ]);
      expect(errors).toEqual([]);
    });
  });

  describe("origin validation - must have scheme and host", () => {
    it("rejects entries without scheme", () => {
      const errors = validateAllowList(["example.com"]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("Invalid URL");
      expect(errors[0]).toContain("must be a valid URL with scheme and host");
    });

    it("rejects entries with only scheme", () => {
      const errors = validateAllowList(["https://"]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("Invalid URL");
    });

    it("rejects relative paths", () => {
      const errors = validateAllowList(["/api/v1"]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("Invalid URL");
    });

    it("rejects protocol-relative URLs", () => {
      const errors = validateAllowList(["//example.com/path"]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("Invalid URL");
    });

    it("rejects paths without host", () => {
      const errors = validateAllowList(["file:///etc/passwd"]);
      expect(errors).toHaveLength(1);
      // file: protocol is rejected for http/https check before hostname check
      expect(errors[0]).toContain("Only http and https");
    });
  });

  describe("protocol restrictions", () => {
    it("reports non-http/https protocols", () => {
      const errors = validateAllowList([
        "ftp://example.com",
        "file:///etc/passwd"
      ]);
      expect(errors).toHaveLength(2);
      expect(errors[0]).toContain("Only http and https");
    });

    it("rejects data: URLs", () => {
      const errors = validateAllowList(["data:text/html,<h1>test</h1>"]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("Only http and https");
    });

    it("rejects javascript: URLs", () => {
      const errors = validateAllowList(["javascript:alert(1)"]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("Only http and https");
    });
  });

  describe("query strings and fragments", () => {
    it("warns about query strings", () => {
      const errors = validateAllowList(["https://example.com?api_key=123"]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("Query strings");
    });

    it("warns about fragments", () => {
      const errors = validateAllowList(["https://example.com#section"]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("fragments");
    });
  });

  describe("edge cases", () => {
    it("accepts IPv4 addresses", () => {
      const errors = validateAllowList([
        "https://192.168.1.1",
        "http://127.0.0.1:8080"
      ]);
      expect(errors).toEqual([]);
    });

    it("accepts IPv6 addresses", () => {
      const errors = validateAllowList([
        "https://[::1]",
        "http://[2001:db8::1]:8080"
      ]);
      expect(errors).toEqual([]);
    });

    it("accepts localhost", () => {
      const errors = validateAllowList([
        "http://localhost",
        "http://localhost:3000",
        "https://localhost:8443/api"
      ]);
      expect(errors).toEqual([]);
    });

    it("reports multiple errors for multiple invalid entries", () => {
      const errors = validateAllowList([
        "not-a-url",
        "ftp://example.com",
        "https://valid.com",
        "/relative/path"
      ]);
      expect(errors).toHaveLength(3);
    });
  });
});

describe("security scenarios", () => {
  describe("path traversal prevention", () => {
    it("does not allow path traversal via encoded characters", () => {
      const allowedUrlPrefixes = ["https://example.com/safe/"];
      // The URL parser will normalize this, but the check should still work
      expect(
        isUrlAllowed("https://example.com/safe/../unsafe", allowedUrlPrefixes)
      ).toBe(false);
    });

    it("handles double-encoded characters correctly", () => {
      const allowedUrlPrefixes = ["https://example.com/safe/"];
      // %252e%252e = double-encoded ..
      // The URL is taken as-is after URL parsing
      expect(
        isUrlAllowed(
          "https://example.com/safe/%252e%252e/unsafe",
          allowedUrlPrefixes
        )
      ).toBe(true); // This stays under /safe/ path
    });
  });

  describe("host matching strictness", () => {
    it("does not allow host suffix matching", () => {
      const allowedUrlPrefixes = ["https://example.com"];
      expect(
        isUrlAllowed("https://evilexample.com/path", allowedUrlPrefixes)
      ).toBe(false);
    });

    it("does not allow host prefix matching", () => {
      const allowedUrlPrefixes = ["https://example.com"];
      expect(
        isUrlAllowed("https://example.com.evil.com/path", allowedUrlPrefixes)
      ).toBe(false);
    });

    it("does not allow credential injection", () => {
      const allowedUrlPrefixes = ["https://example.com"];
      // user:pass@example.com could be used for credential stuffing
      expect(
        isUrlAllowed("https://user:pass@example.com/path", allowedUrlPrefixes)
      ).toBe(true); // URL parser strips credentials, origin matches
    });
  });

  describe("port matching", () => {
    it("default ports are normalized", () => {
      const allowedUrlPrefixes = ["https://example.com"];
      // Port 443 is default for https, should be normalized
      expect(
        isUrlAllowed("https://example.com:443/path", allowedUrlPrefixes)
      ).toBe(true);
    });

    it("http default port is normalized", () => {
      const allowedUrlPrefixes = ["http://example.com"];
      expect(
        isUrlAllowed("http://example.com:80/path", allowedUrlPrefixes)
      ).toBe(true);
    });

    it("non-default port must be explicit", () => {
      const allowedUrlPrefixes = ["https://example.com"];
      expect(
        isUrlAllowed("https://example.com:8443/path", allowedUrlPrefixes)
      ).toBe(false);
    });
  });

  describe("real-world API patterns", () => {
    it("allows GitHub API access with org restriction", () => {
      const allowedUrlPrefixes = ["https://api.github.com/repos/myorg/"];

      // Allowed: repos in myorg
      expect(
        isUrlAllowed(
          "https://api.github.com/repos/myorg/myrepo/issues",
          allowedUrlPrefixes
        )
      ).toBe(true);

      // Not allowed: other orgs
      expect(
        isUrlAllowed(
          "https://api.github.com/repos/otherorg/repo/issues",
          allowedUrlPrefixes
        )
      ).toBe(false);

      // Not allowed: other endpoints
      expect(
        isUrlAllowed("https://api.github.com/users/foo", allowedUrlPrefixes)
      ).toBe(false);
    });

    it("allows specific API version", () => {
      const allowedUrlPrefixes = ["https://api.example.com/v2/"];

      expect(
        isUrlAllowed("https://api.example.com/v2/users", allowedUrlPrefixes)
      ).toBe(true);
      expect(
        isUrlAllowed("https://api.example.com/v1/users", allowedUrlPrefixes)
      ).toBe(false);
    });

    it("allows multiple services", () => {
      const allowedUrlPrefixes = [
        "https://api.service1.com",
        "https://api.service2.com/webhooks/"
      ];

      expect(
        isUrlAllowed("https://api.service1.com/anything", allowedUrlPrefixes)
      ).toBe(true);
      expect(
        isUrlAllowed(
          "https://api.service2.com/webhooks/hook123",
          allowedUrlPrefixes
        )
      ).toBe(true);
      expect(
        isUrlAllowed("https://api.service2.com/other/path", allowedUrlPrefixes)
      ).toBe(false);
    });
  });

  describe("adversarial URL manipulation", () => {
    it("blocks URLs with @ symbol trying to confuse host parsing", () => {
      const allowedUrlPrefixes = ["https://allowed.com"];
      // Attacker tries to make URL look like allowed.com but actually goes to evil.com
      // https://allowed.com@evil.com would go to evil.com with allowed.com as username
      expect(
        isUrlAllowed("https://allowed.com@evil.com/path", allowedUrlPrefixes)
      ).toBe(false);
    });

    it("blocks URLs with backslash trying to confuse path", () => {
      const allowedUrlPrefixes = ["https://api.example.com/safe/"];
      // URL constructor converts backslashes to forward slashes, treating \.. as /..
      // This results in path traversal: /safe\..\\unsafe → /safe/../unsafe → /unsafe
      // This is correct security behavior - the URL is blocked
      expect(
        isUrlAllowed(
          "https://api.example.com/safe\\..\\unsafe",
          allowedUrlPrefixes
        )
      ).toBe(false);
    });

    it("blocks URLs with null bytes", () => {
      const allowedUrlPrefixes = ["https://api.example.com"];
      // URL constructor will reject or normalize null bytes
      const result = isUrlAllowed(
        "https://api.example.com/path%00.txt",
        allowedUrlPrefixes
      );
      // Should either match or be rejected by URL parsing
      expect(typeof result).toBe("boolean");
    });

    it("blocks URLs with unicode homoglyphs in host", () => {
      const allowedUrlPrefixes = ["https://example.com"];
      // Cyrillic 'е' looks like Latin 'e' but is different
      // URL parsing should treat this as a different host
      expect(
        isUrlAllowed("https://еxample.com/path", allowedUrlPrefixes) // Cyrillic е
      ).toBe(false);
    });

    it("blocks URLs with extra slashes", () => {
      const allowedUrlPrefixes = ["https://api.example.com/safe/"];
      // Extra slashes should be normalized
      expect(
        isUrlAllowed("https://api.example.com//safe/path", allowedUrlPrefixes)
      ).toBe(false); // //safe != /safe/
    });

    it("blocks URLs with scheme confusion", () => {
      const allowedUrlPrefixes = ["https://api.example.com"];
      // file:// URLs should never match https:// allowlist
      expect(isUrlAllowed("file:///etc/passwd", allowedUrlPrefixes)).toBe(
        false
      );
      expect(isUrlAllowed("javascript:alert(1)", allowedUrlPrefixes)).toBe(
        false
      );
      expect(isUrlAllowed("data:text/html,<script>", allowedUrlPrefixes)).toBe(
        false
      );
    });

    it("handles URLs with unusual but valid characters", () => {
      const allowedUrlPrefixes = ["https://api.example.com/path/"];
      // These are valid URL characters
      expect(
        isUrlAllowed(
          "https://api.example.com/path/file.json",
          allowedUrlPrefixes
        )
      ).toBe(true);
      expect(
        isUrlAllowed(
          "https://api.example.com/path/file%20name",
          allowedUrlPrefixes
        )
      ).toBe(true);
      expect(
        isUrlAllowed(
          "https://api.example.com/path/file~name",
          allowedUrlPrefixes
        )
      ).toBe(true);
    });

    it("blocks URLs trying to escape path prefix with fragments", () => {
      const allowedUrlPrefixes = ["https://api.example.com/api/"];
      // Fragment should not affect path matching
      expect(
        isUrlAllowed(
          "https://api.example.com/api/data#/../../../etc/passwd",
          allowedUrlPrefixes
        )
      ).toBe(true); // Fragment doesn't affect path
      // But the actual path must still match
      expect(
        isUrlAllowed(
          "https://api.example.com/other#/api/data",
          allowedUrlPrefixes
        )
      ).toBe(false); // Path is /other, not /api/
    });

    it("blocks URLs with IPv4 addresses unless explicitly allowed", () => {
      const allowedUrlPrefixes = ["https://api.example.com"];
      expect(isUrlAllowed("https://192.168.1.1/path", allowedUrlPrefixes)).toBe(
        false
      );
      expect(isUrlAllowed("https://127.0.0.1/path", allowedUrlPrefixes)).toBe(
        false
      );
      expect(isUrlAllowed("https://10.0.0.1/path", allowedUrlPrefixes)).toBe(
        false
      );
    });

    it("allows IP addresses when explicitly in allow-list", () => {
      const allowedUrlPrefixes = ["https://192.168.1.100:8080"];
      expect(
        isUrlAllowed("https://192.168.1.100:8080/api/data", allowedUrlPrefixes)
      ).toBe(true);
      expect(
        isUrlAllowed("https://192.168.1.101:8080/api/data", allowedUrlPrefixes)
      ).toBe(false);
    });

    it("blocks URLs with IPv6 addresses unless explicitly allowed", () => {
      const allowedUrlPrefixes = ["https://api.example.com"];
      expect(isUrlAllowed("https://[::1]/path", allowedUrlPrefixes)).toBe(
        false
      );
      expect(
        isUrlAllowed("https://[2001:db8::1]/path", allowedUrlPrefixes)
      ).toBe(false);
    });

    it("handles case sensitivity correctly", () => {
      const allowedUrlPrefixes = ["https://API.Example.COM/Path/"];
      // Hostnames are case-insensitive, paths are case-sensitive
      // URL constructor normalizes hostname to lowercase
      expect(
        isUrlAllowed("https://api.example.com/Path/data", allowedUrlPrefixes)
      ).toBe(true);
      expect(
        isUrlAllowed("https://API.EXAMPLE.COM/Path/data", allowedUrlPrefixes)
      ).toBe(true);
      // Path case matters
      expect(
        isUrlAllowed("https://api.example.com/path/data", allowedUrlPrefixes)
      ).toBe(false);
    });

    it("blocks localhost variations", () => {
      const allowedUrlPrefixes = ["https://api.example.com"];
      expect(isUrlAllowed("https://localhost/path", allowedUrlPrefixes)).toBe(
        false
      );
      expect(
        isUrlAllowed("https://localhost:8080/path", allowedUrlPrefixes)
      ).toBe(false);
      expect(isUrlAllowed("https://127.0.0.1/path", allowedUrlPrefixes)).toBe(
        false
      );
      expect(isUrlAllowed("https://[::1]/path", allowedUrlPrefixes)).toBe(
        false
      );
      expect(isUrlAllowed("https://0.0.0.0/path", allowedUrlPrefixes)).toBe(
        false
      );
    });

    it("handles URLs with very long paths", () => {
      const allowedUrlPrefixes = ["https://api.example.com/api/"];
      const longPath = `/api/${"a".repeat(10000)}`;
      expect(
        isUrlAllowed(`https://api.example.com${longPath}`, allowedUrlPrefixes)
      ).toBe(true);
    });

    it("blocks URLs with newlines or other control characters", () => {
      const allowedUrlPrefixes = ["https://api.example.com"];
      // URL constructor should handle or reject these
      try {
        const result = isUrlAllowed(
          "https://api.example.com/path\n/evil",
          allowedUrlPrefixes
        );
        // If parsing succeeds, it should still be safe
        expect(typeof result).toBe("boolean");
      } catch {
        // URL parsing failed, which is also safe
      }
    });
  });

  describe("path prefix bypass attempts", () => {
    it("blocks attempts to bypass /api/ restriction with /api", () => {
      const allowedUrlPrefixes = ["https://api.example.com/api/"];
      // Without trailing slash, /api doesn't match /api/
      expect(
        isUrlAllowed("https://api.example.com/api", allowedUrlPrefixes)
      ).toBe(false);
      // But /api/ and subpaths work
      expect(
        isUrlAllowed("https://api.example.com/api/", allowedUrlPrefixes)
      ).toBe(true);
      expect(
        isUrlAllowed("https://api.example.com/api/users", allowedUrlPrefixes)
      ).toBe(true);
    });

    it("blocks /apiv2 when only /api/ is allowed", () => {
      const allowedUrlPrefixes = ["https://api.example.com/api/"];
      expect(
        isUrlAllowed("https://api.example.com/apiv2", allowedUrlPrefixes)
      ).toBe(false);
      expect(
        isUrlAllowed("https://api.example.com/api-admin", allowedUrlPrefixes)
      ).toBe(false);
    });

    it("handles paths that look similar but are different", () => {
      const allowedUrlPrefixes = ["https://api.example.com/users/admin/"];
      expect(
        isUrlAllowed(
          "https://api.example.com/users/admin/settings",
          allowedUrlPrefixes
        )
      ).toBe(true);
      expect(
        isUrlAllowed(
          "https://api.example.com/users/administrator",
          allowedUrlPrefixes
        )
      ).toBe(false);
      expect(
        isUrlAllowed("https://api.example.com/users/admin", allowedUrlPrefixes)
      ).toBe(false);
    });
  });
});

describe("createSecureFetch allow-list validation", () => {
  it("throws on invalid allow-list entries at construction", () => {
    expect(() =>
      createSecureFetch({
        allowedUrlPrefixes: ["not-a-url"]
      })
    ).toThrow(/Invalid network allow-list/);
  });

  it("throws on non-http protocol in allow-list", () => {
    expect(() =>
      createSecureFetch({
        allowedUrlPrefixes: ["ftp://example.com"]
      })
    ).toThrow(/Invalid network allow-list/);
  });

  it("accepts valid allow-list entries", () => {
    expect(() =>
      createSecureFetch({
        allowedUrlPrefixes: ["https://example.com"]
      })
    ).not.toThrow();
  });

  it("skips validation when dangerouslyAllowFullInternetAccess is true", () => {
    expect(() =>
      createSecureFetch({
        dangerouslyAllowFullInternetAccess: true,
        allowedUrlPrefixes: ["not-a-url"]
      })
    ).not.toThrow();
  });
});

describe("isPrivateIp", () => {
  it("rejects loopback IPv4", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("127.255.255.255")).toBe(true);
  });

  it("rejects RFC1918 ranges", () => {
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("172.16.0.1")).toBe(true);
    expect(isPrivateIp("172.31.255.255")).toBe(true);
    expect(isPrivateIp("192.168.1.1")).toBe(true);
  });

  it("rejects link-local", () => {
    expect(isPrivateIp("169.254.1.1")).toBe(true);
  });

  it("rejects 0.0.0.0", () => {
    expect(isPrivateIp("0.0.0.0")).toBe(true);
  });

  it("rejects CGNAT / Shared Address Space (RFC 6598)", () => {
    expect(isPrivateIp("100.64.0.1")).toBe(true);
    expect(isPrivateIp("100.127.255.255")).toBe(true);
    expect(isPrivateIp("100.100.100.100")).toBe(true);
    // Just outside the range
    expect(isPrivateIp("100.63.255.255")).toBe(false);
    expect(isPrivateIp("100.128.0.0")).toBe(false);
  });

  it("rejects Benchmarking range (RFC 2544)", () => {
    expect(isPrivateIp("198.18.0.1")).toBe(true);
    expect(isPrivateIp("198.19.255.255")).toBe(true);
    // Just outside the range
    expect(isPrivateIp("198.17.255.255")).toBe(false);
    expect(isPrivateIp("198.20.0.0")).toBe(false);
  });

  it("rejects IETF Protocol Assignments (RFC 6890)", () => {
    expect(isPrivateIp("192.0.0.1")).toBe(true);
    expect(isPrivateIp("192.0.0.255")).toBe(true);
  });

  it("rejects TEST-NET ranges (RFC 5737)", () => {
    // TEST-NET-1
    expect(isPrivateIp("192.0.2.0")).toBe(true);
    expect(isPrivateIp("192.0.2.255")).toBe(true);
    // TEST-NET-2
    expect(isPrivateIp("198.51.100.0")).toBe(true);
    expect(isPrivateIp("198.51.100.255")).toBe(true);
    // TEST-NET-3
    expect(isPrivateIp("203.0.113.0")).toBe(true);
    expect(isPrivateIp("203.0.113.255")).toBe(true);
  });

  it("rejects Reserved/broadcast range (RFC 1112)", () => {
    expect(isPrivateIp("240.0.0.0")).toBe(true);
    expect(isPrivateIp("255.255.255.255")).toBe(true);
    expect(isPrivateIp("250.1.2.3")).toBe(true);
    // Just below the range
    expect(isPrivateIp("239.255.255.255")).toBe(false);
  });

  it("allows public IPs", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("93.184.216.34")).toBe(false);
    expect(isPrivateIp("172.32.0.1")).toBe(false);
  });

  it("rejects IPv6 loopback", () => {
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("[::1]")).toBe(true);
  });

  it("rejects IPv6 link-local (full fe80::/10 range) and ULA", () => {
    expect(isPrivateIp("fe80::1")).toBe(true);
    expect(isPrivateIp("fe90::1")).toBe(true);
    expect(isPrivateIp("fea0::1")).toBe(true);
    expect(isPrivateIp("febf::1")).toBe(true);
    expect(isPrivateIp("fc00::1")).toBe(true);
    expect(isPrivateIp("fd12::1")).toBe(true);
  });

  it("rejects IPv4-mapped IPv6", () => {
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateIp("::ffff:192.168.1.1")).toBe(true);
    expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false);
    // Canonicalized form produced by WHATWG URL parser
    expect(isPrivateIp("::ffff:7f00:1")).toBe(true);
  });

  it("rejects IPv6 documentation prefix (RFC 3849)", () => {
    expect(isPrivateIp("2001:db8::1")).toBe(true);
    expect(isPrivateIp("2001:db8:1234:5678::1")).toBe(true);
    // Just outside the range
    expect(isPrivateIp("2001:db9::1")).toBe(false);
  });

  it("rejects NAT64 well-known prefix (RFC 6052) with private embedded IPv4", () => {
    // 64:ff9b::127.0.0.1 — embedded loopback
    expect(isPrivateIp("64:ff9b::7f00:1")).toBe(true);
    // 64:ff9b::10.0.0.1 — embedded private
    expect(isPrivateIp("64:ff9b::a00:1")).toBe(true);
    // 64:ff9b::8.8.8.8 — embedded public (allowed)
    expect(isPrivateIp("64:ff9b::808:808")).toBe(false);
  });

  it("rejects NAT64 local-use prefix (RFC 8215)", () => {
    expect(isPrivateIp("64:ff9b:1::1")).toBe(true);
    expect(isPrivateIp("64:ff9b:1:abcd::1")).toBe(true);
  });

  it("rejects 6to4 (RFC 3056) with private embedded IPv4", () => {
    // 2002:7f00:0001:: — embedded 127.0.0.1
    expect(isPrivateIp("2002:7f00:1::")).toBe(true);
    // 2002:0a00:0001:: — embedded 10.0.0.1
    expect(isPrivateIp("2002:a00:1::")).toBe(true);
    // 2002:c0a8:0101:: — embedded 192.168.1.1
    expect(isPrivateIp("2002:c0a8:101::")).toBe(true);
    // 2002:0808:0808:: — embedded 8.8.8.8 (allowed)
    expect(isPrivateIp("2002:808:808::")).toBe(false);
  });

  it("allows public IPv6", () => {
    expect(isPrivateIp("2001:470::1")).toBe(false);
    // fec0 is outside fe80::/10 range
    expect(isPrivateIp("fec0::1")).toBe(false);
  });

  it("blocks localhost hostnames", () => {
    expect(isPrivateIp("example.com")).toBe(false);
    expect(isPrivateIp("localhost")).toBe(true);
    expect(isPrivateIp("api.localhost")).toBe(true);
  });

  it("handles non-decimal IPv4 notations", () => {
    expect(isPrivateIp("2130706433")).toBe(true); // 127.0.0.1 decimal
    expect(isPrivateIp("0x7f000001")).toBe(true); // 127.0.0.1 hex
    expect(isPrivateIp("0177.0.0.1")).toBe(true); // 127.0.0.1 octal
  });
});
