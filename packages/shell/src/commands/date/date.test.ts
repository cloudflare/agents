import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

/** Format date in UTC as YYYY-MM-DD (sandbox always uses UTC) */
function formatUTCDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

describe("date", () => {
  describe("format specifiers", () => {
    it("should format year with %Y", async () => {
      const env = new Bash();
      const result = await env.exec("date +%Y");
      expect(result.stdout).toMatch(/^\d{4}\n$/);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should format month with %m", async () => {
      const env = new Bash();
      const result = await env.exec("date +%m");
      expect(result.stdout).toMatch(/^(0[1-9]|1[0-2])\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should format day with %d", async () => {
      const env = new Bash();
      const result = await env.exec("date +%d");
      expect(result.stdout).toMatch(/^(0[1-9]|[12]\d|3[01])\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should format ISO date with %F", async () => {
      const env = new Bash();
      const result = await env.exec("date +%F");
      expect(result.stdout).toMatch(/^\d{4}-\d{2}-\d{2}\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should format time with %T", async () => {
      const env = new Bash();
      const result = await env.exec("date +%T");
      expect(result.stdout).toMatch(/^\d{2}:\d{2}:\d{2}\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should format hours with %H", async () => {
      const env = new Bash();
      const result = await env.exec("date +%H");
      expect(result.stdout).toMatch(/^([01]\d|2[0-3])\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should format 12-hour with %I", async () => {
      const env = new Bash();
      const result = await env.exec("date +%I");
      expect(result.stdout).toMatch(/^(0[1-9]|1[0-2])\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should format minutes with %M", async () => {
      const env = new Bash();
      const result = await env.exec("date +%M");
      expect(result.stdout).toMatch(/^[0-5]\d\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should format seconds with %S", async () => {
      const env = new Bash();
      const result = await env.exec("date +%S");
      expect(result.stdout).toMatch(/^[0-5]\d\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should format weekday name with %a", async () => {
      const env = new Bash();
      const result = await env.exec("date +%a");
      expect(result.stdout).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should format month name with %b", async () => {
      const env = new Bash();
      const result = await env.exec("date +%b");
      expect(result.stdout).toMatch(
        /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\n$/
      );
      expect(result.exitCode).toBe(0);
    });

    it("should format unix timestamp with %s", async () => {
      const env = new Bash();
      const result = await env.exec("date +%s");
      const timestamp = Number.parseInt(result.stdout.trim(), 10);
      expect(timestamp).toBeGreaterThan(1700000000);
      expect(result.exitCode).toBe(0);
    });

    it("should format AM/PM with %p", async () => {
      const env = new Bash();
      const result = await env.exec("date +%p");
      expect(result.stdout).toMatch(/^(AM|PM)\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should handle literal percent with %%", async () => {
      const env = new Bash();
      const result = await env.exec("date +%%");
      expect(result.stdout).toBe("%\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle combined format string", async () => {
      const env = new Bash();
      const result = await env.exec("date '+%Y-%m-%d %H:%M:%S'");
      expect(result.stdout).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should handle newline with %n", async () => {
      const env = new Bash();
      const result = await env.exec("date '+%Y%n%m'");
      expect(result.stdout).toMatch(/^\d{4}\n\d{2}\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should handle tab with %t", async () => {
      const env = new Bash();
      const result = await env.exec("date '+%Y%t%m'");
      expect(result.stdout).toMatch(/^\d{4}\t\d{2}\n$/);
      expect(result.exitCode).toBe(0);
    });
  });

  describe("options", () => {
    it("should parse date string with -d", async () => {
      const env = new Bash();
      const result = await env.exec("date -d '2024-01-15T12:00:00' +%Y-%m-%d");
      expect(result.stdout).toBe("2024-01-15\n");
      expect(result.exitCode).toBe(0);
    });

    it("should parse date string with --date", async () => {
      const env = new Bash();
      const result = await env.exec("date --date='2024-06-20T12:00:00' +%F");
      expect(result.stdout).toBe("2024-06-20\n");
      expect(result.exitCode).toBe(0);
    });

    it("should output ISO format with -I", async () => {
      const env = new Bash();
      const result = await env.exec("date -I");
      expect(result.stdout).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(result.exitCode).toBe(0);
    });

    it("should output RFC format with -R", async () => {
      const env = new Bash();
      const result = await env.exec("date -R");
      expect(result.stdout).toMatch(
        /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}/
      );
      expect(result.exitCode).toBe(0);
    });

    it("should output UTC with -u", async () => {
      const env = new Bash();
      const result = await env.exec("date -u +%Z");
      expect(result.stdout).toBe("UTC\n");
      expect(result.exitCode).toBe(0);
    });

    it("should output UTC timezone offset with -u", async () => {
      const env = new Bash();
      const result = await env.exec("date -u +%z");
      expect(result.stdout).toBe("+0000\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("relative dates", () => {
    it("should parse 'now'", async () => {
      const env = new Bash();
      const result = await env.exec("date -d now +%s");
      const timestamp = Number.parseInt(result.stdout.trim(), 10);
      const now = Math.floor(Date.now() / 1000);
      expect(Math.abs(timestamp - now)).toBeLessThan(5);
      expect(result.exitCode).toBe(0);
    });

    it("should parse 'today'", async () => {
      const env = new Bash();
      const result = await env.exec("date -d today +%F");
      // Use local date formatting to match date command behavior
      const today = formatUTCDate(new Date());
      expect(result.stdout).toBe(`${today}\n`);
      expect(result.exitCode).toBe(0);
    });

    it("should parse 'yesterday'", async () => {
      const env = new Bash();
      const result = await env.exec("date -d yesterday +%F");
      const yesterday = new Date(Date.now() - 86400000);
      expect(result.stdout).toBe(`${formatUTCDate(yesterday)}\n`);
      expect(result.exitCode).toBe(0);
    });

    it("should parse 'tomorrow'", async () => {
      const env = new Bash();
      const result = await env.exec("date -d tomorrow +%F");
      const tomorrow = new Date(Date.now() + 86400000);
      expect(result.stdout).toBe(`${formatUTCDate(tomorrow)}\n`);
      expect(result.exitCode).toBe(0);
    });
  });

  describe("error handling", () => {
    it("should error on invalid date string", async () => {
      const env = new Bash();
      const result = await env.exec("date -d 'invalid date string xyz'");
      expect(result.stderr).toContain("invalid date");
      expect(result.exitCode).toBe(1);
    });

    it("should error on unknown option", async () => {
      const env = new Bash();
      const result = await env.exec("date --unknown");
      expect(result.stderr).toContain("unrecognized option");
      expect(result.exitCode).toBe(1);
    });

    it("should error on unknown short option", async () => {
      const env = new Bash();
      const result = await env.exec("date -z");
      expect(result.stderr).toContain("invalid option");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("help", () => {
    it("should show help with --help", async () => {
      const env = new Bash();
      const result = await env.exec("date --help");
      expect(result.stdout).toContain("date");
      expect(result.stdout).toContain("FORMAT");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("default output", () => {
    it("should output default format without arguments", async () => {
      const env = new Bash();
      const result = await env.exec("date");
      // Default format includes weekday, month, day, time, timezone, year
      expect(result.stdout).toMatch(
        /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/
      );
      expect(result.exitCode).toBe(0);
    });
  });

  describe("timezone non-disclosure", () => {
    it("%Z should return UTC, never the host timezone", async () => {
      const env = new Bash();
      const result = await env.exec("date +%Z");
      expect(result.stdout.trim()).toBe("UTC");
      // Must not contain a real timezone like America/New_York, etc.
      expect(result.stdout).not.toContain("/");
    });

    it("%z should return +0000, never the host UTC offset", async () => {
      const env = new Bash();
      const result = await env.exec("date +%z");
      expect(result.stdout.trim()).toBe("+0000");
    });

    it("default output should show UTC timezone", async () => {
      const env = new Bash();
      const result = await env.exec("date");
      // Default format includes %Z which should be UTC
      expect(result.stdout).toContain("UTC");
    });

    it("-I (iso) format should use +0000 offset", async () => {
      const env = new Bash();
      const result = await env.exec("date -I");
      expect(result.stdout).toContain("+0000");
    });

    it("-R (rfc) format should use +0000 offset", async () => {
      const env = new Bash();
      const result = await env.exec("date -R");
      expect(result.stdout).toContain("+0000");
    });

    it("-u flag should still work (already UTC)", async () => {
      const env = new Bash();
      const result = await env.exec("date -u +%Z");
      expect(result.stdout.trim()).toBe("UTC");
    });

    it("time values should be UTC (consistent with %Z)", async () => {
      const env = new Bash();
      // Use a fixed date to verify UTC conversion
      const result = await env.exec(
        "date -d '2024-01-15T00:00:00Z' '+%H:%M:%S'"
      );
      expect(result.stdout.trim()).toBe("00:00:00");
    });
  });
});
