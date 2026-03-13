/**
 * Tests for curl URL allow-list enforcement
 */

import { describe, expect, it } from "vitest";
import { Bash } from "../../../Shell";

describe("curl URL allow-list", () => {
  describe("basic enforcement", () => {
    it("allows URLs in allow-list", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec("curl https://api.example.com/test");
      // May fail due to actual network, but should not be "access denied"
      expect(result.stderr).not.toContain("Network access denied");
    });

    it("blocks URLs not in allow-list", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec("curl https://other-domain.com/test");
      expect(result.exitCode).toBe(7);
      expect(result.stderr).toContain("Network access denied");
    });
  });

  describe("path prefix restrictions", () => {
    it("allows URLs matching prefix", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com/v1/"] }
      });
      const result = await env.exec("curl https://api.example.com/v1/users");
      expect(result.stderr).not.toContain("Network access denied");
    });

    it("blocks URLs not matching prefix", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com/v1/"] }
      });
      const result = await env.exec("curl https://api.example.com/v2/users");
      expect(result.stderr).toContain("Network access denied");
    });
  });

  describe("multiple allowed URLs", () => {
    it("allows any matching URL", async () => {
      const env = new Bash({
        network: {
          allowedUrlPrefixes: [
            "https://api1.example.com",
            "https://api2.example.com"
          ]
        }
      });

      const result1 = await env.exec("curl https://api1.example.com/test");
      expect(result1.stderr).not.toContain("Network access denied");

      const result2 = await env.exec("curl https://api2.example.com/test");
      expect(result2.stderr).not.toContain("Network access denied");
    });

    it("blocks URLs not matching any entry", async () => {
      const env = new Bash({
        network: {
          allowedUrlPrefixes: [
            "https://api1.example.com",
            "https://api2.example.com"
          ]
        }
      });
      const result = await env.exec("curl https://api3.example.com/test");
      expect(result.stderr).toContain("Network access denied");
    });
  });

  describe("dangerouslyAllowFullInternetAccess", () => {
    it("allows any URL with dangerous flag", async () => {
      const env = new Bash({
        network: { dangerouslyAllowFullInternetAccess: true }
      });
      const result = await env.exec("curl https://any-domain.com/test");
      expect(result.stderr).not.toContain("Network access denied");
    });
  });

  describe("security scenarios", () => {
    it("blocks subdomain attacks", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://example.com"] }
      });
      const result = await env.exec("curl https://evil.example.com/path");
      expect(result.exitCode).toBe(7);
    });

    it("blocks scheme downgrade", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec("curl http://api.example.com/data");
      expect(result.exitCode).toBe(7);
    });

    it("blocks port confusion", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec("curl https://api.example.com:8080/data");
      expect(result.exitCode).toBe(7);
    });
  });
});
