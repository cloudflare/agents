import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("prompt expansion", () => {
  describe("basic escapes", () => {
    it("should expand \\n to newline", async () => {
      const env = new Bash();
      const result = await env.exec(
        "PS4=$'line1\\nline2\\n'; echo \"${PS4@P}\""
      );
      expect(result.stdout).toBe("line1\nline2\n\n");
      expect(result.exitCode).toBe(0);
    });

    it("should expand \\r to carriage return", async () => {
      const env = new Bash();
      const result = await env.exec("x=$'a\\rb'; echo \"${x@P}\"");
      expect(result.stdout).toBe("a\rb\n");
      expect(result.exitCode).toBe(0);
    });

    it("should expand \\\\ to backslash", async () => {
      const env = new Bash();
      const result = await env.exec('x="a\\\\b"; echo "${x@P}"');
      expect(result.stdout).toBe("a\\b\n");
      expect(result.exitCode).toBe(0);
    });

    it("should expand \\a to bell character", async () => {
      const env = new Bash();
      const result = await env.exec('x="\\a"; echo "${x@P}"');
      expect(result.stdout).toBe("\x07\n");
      expect(result.exitCode).toBe(0);
    });

    it("should expand \\e to escape character", async () => {
      const env = new Bash();
      const result = await env.exec('x="\\e[1m"; echo "${x@P}"');
      expect(result.stdout).toBe("\x1b[1m\n");
      expect(result.exitCode).toBe(0);
    });

    it("should expand \\$ to $ for regular user", async () => {
      const env = new Bash();
      const result = await env.exec('x="prompt\\$ "; echo "${x@P}"');
      expect(result.stdout).toBe("prompt$ \n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("user and host escapes", () => {
    it("should expand \\u to username", async () => {
      const env = new Bash({ env: { USER: "testuser" } });
      const result = await env.exec('x="\\u"; echo "${x@P}"');
      expect(result.stdout).toBe("testuser\n");
      expect(result.exitCode).toBe(0);
    });

    it("should expand \\h to short hostname", async () => {
      const env = new Bash({ env: { HOSTNAME: "myhost.example.com" } });
      const result = await env.exec('x="\\h"; echo "${x@P}"');
      expect(result.stdout).toBe("myhost\n");
      expect(result.exitCode).toBe(0);
    });

    it("should expand \\H to full hostname", async () => {
      const env = new Bash({ env: { HOSTNAME: "myhost.example.com" } });
      const result = await env.exec('x="\\H"; echo "${x@P}"');
      expect(result.stdout).toBe("myhost.example.com\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("directory escapes", () => {
    it("should expand \\w to current working directory", async () => {
      const env = new Bash({
        env: { PWD: "/home/user/project", HOME: "/home/user" }
      });
      const result = await env.exec('x="\\w"; echo "${x@P}"');
      expect(result.stdout).toBe("~/project\n");
      expect(result.exitCode).toBe(0);
    });

    it("should expand \\w to full path when not under HOME", async () => {
      const env = new Bash({ env: { PWD: "/var/log", HOME: "/home/user" } });
      const result = await env.exec('x="\\w"; echo "${x@P}"');
      expect(result.stdout).toBe("/var/log\n");
      expect(result.exitCode).toBe(0);
    });

    it("should expand \\W to basename of cwd", async () => {
      const env = new Bash({ env: { PWD: "/home/user/project" } });
      const result = await env.exec('x="\\W"; echo "${x@P}"');
      expect(result.stdout).toBe("project\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("shell info escapes", () => {
    it("should expand \\s to shell name", async () => {
      const env = new Bash();
      const result = await env.exec('x="\\s"; echo "${x@P}"');
      expect(result.stdout).toBe("bash\n");
      expect(result.exitCode).toBe(0);
    });

    it("should expand \\v to version major.minor", async () => {
      const env = new Bash();
      const result = await env.exec('x="\\v"; echo "${x@P}"');
      expect(result.stdout).toBe("5.0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should expand \\V to full version", async () => {
      const env = new Bash();
      const result = await env.exec('x="\\V"; echo "${x@P}"');
      expect(result.stdout).toBe("5.0.0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should expand \\j to number of jobs", async () => {
      const env = new Bash();
      const result = await env.exec('x="\\j"; echo "${x@P}"');
      expect(result.stdout).toBe("0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should expand \\l to terminal name", async () => {
      const env = new Bash();
      const result = await env.exec('x="\\l"; echo "${x@P}"');
      expect(result.stdout).toBe("tty\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("time escapes", () => {
    it("should expand \\t to 24-hour time HH:MM:SS", async () => {
      const env = new Bash();
      const result = await env.exec('x="\\t"; echo "${x@P}"');
      // Just verify format: HH:MM:SS
      expect(result.stdout).toMatch(/^\d{2}:\d{2}:\d{2}\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should expand \\T to 12-hour time HH:MM:SS", async () => {
      const env = new Bash();
      const result = await env.exec('x="\\T"; echo "${x@P}"');
      // Just verify format: HH:MM:SS (12-hour)
      expect(result.stdout).toMatch(/^\d{2}:\d{2}:\d{2}\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should expand \\@ to 12-hour time with AM/PM", async () => {
      const env = new Bash();
      const result = await env.exec('x="\\@"; echo "${x@P}"');
      // Format: HH:MM AM/PM
      expect(result.stdout).toMatch(/^\d{2}:\d{2} [AP]M\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should expand \\A to 24-hour time HH:MM", async () => {
      const env = new Bash();
      const result = await env.exec('x="\\A"; echo "${x@P}"');
      expect(result.stdout).toMatch(/^\d{2}:\d{2}\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should expand \\d to date", async () => {
      const env = new Bash();
      const result = await env.exec('x="\\d"; echo "${x@P}"');
      // Format: Day Mon DD
      expect(result.stdout).toMatch(
        /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d\n$/
      );
      expect(result.exitCode).toBe(0);
    });
  });

  describe("strftime with \\D{format}", () => {
    it("should expand \\D{%Y} to year", async () => {
      const env = new Bash();
      const result = await env.exec('x="\\D{%Y}"; echo "${x@P}"');
      expect(result.stdout).toMatch(/^\d{4}\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should expand \\D{%m} to month", async () => {
      const env = new Bash();
      const result = await env.exec('x="\\D{%m}"; echo "${x@P}"');
      expect(result.stdout).toMatch(/^\d{2}\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should expand \\D{%d} to day", async () => {
      const env = new Bash();
      const result = await env.exec('x="\\D{%d}"; echo "${x@P}"');
      expect(result.stdout).toMatch(/^\d{2}\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should expand \\D{%H:%M:%S} to time", async () => {
      const env = new Bash();
      const result = await env.exec('x="\\D{%H:%M:%S}"; echo "${x@P}"');
      expect(result.stdout).toMatch(/^\d{2}:\d{2}:\d{2}\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should expand \\D{} to default time format", async () => {
      const env = new Bash();
      const result = await env.exec('x="\\D{}"; echo "${x@P}"');
      expect(result.stdout).toMatch(/^\d{2}:\d{2}:\d{2}\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should expand \\D{%a %b} to abbreviated day and month", async () => {
      const env = new Bash();
      const result = await env.exec('x="\\D{%a %b}"; echo "${x@P}"');
      expect(result.stdout).toMatch(
        /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\n$/
      );
      expect(result.exitCode).toBe(0);
    });

    it("should handle \\D without braces as literal", async () => {
      const env = new Bash();
      const result = await env.exec('x="\\Dfoo"; echo "${x@P}"');
      expect(result.stdout).toBe("\\Dfoo\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("octal escapes", () => {
    it("should expand \\NNN octal codes", async () => {
      const env = new Bash();
      const result = await env.exec('x="\\101\\102\\103"; echo "${x@P}"');
      expect(result.stdout).toBe("ABC\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle wraparound for large octal values", async () => {
      const env = new Bash();
      // \555 = 365 octal = 245 decimal, wraps to 109 = 'm'
      const result = await env.exec('x="\\555"; echo "${x@P}"');
      expect(result.stdout.charCodeAt(0)).toBe(365 % 256);
    });
  });

  describe("command number escapes", () => {
    it("should expand \\# to command number", async () => {
      const env = new Bash({ env: { __COMMAND_NUMBER: "42" } });
      const result = await env.exec('x="cmd \\#"; echo "${x@P}"');
      expect(result.stdout).toBe("cmd 42\n");
      expect(result.exitCode).toBe(0);
    });

    it("should expand \\! to history number", async () => {
      const env = new Bash({ env: { __COMMAND_NUMBER: "123" } });
      const result = await env.exec('x="hist \\!"; echo "${x@P}"');
      expect(result.stdout).toBe("hist 123\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("non-printing delimiters", () => {
    it("should remove \\[ and \\] delimiters", async () => {
      const env = new Bash();
      const result = await env.exec(
        'x="\\[\\e[1m\\]bold\\[\\e[0m\\]"; echo "${x@P}"'
      );
      expect(result.stdout).toBe("\x1b[1mbold\x1b[0m\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("combined prompts", () => {
    it("should expand complex PS1-like prompt", async () => {
      const env = new Bash({
        env: {
          USER: "alice",
          HOSTNAME: "dev.local",
          PWD: "/home/alice/project",
          HOME: "/home/alice"
        }
      });
      const result = await env.exec('x="\\u@\\h:\\w\\$ "; echo "${x@P}"');
      expect(result.stdout).toBe("alice@dev:~/project$ \n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle unknown escapes as literal", async () => {
      const env = new Bash();
      const result = await env.exec('x="\\z\\q\\x"; echo "${x@P}"');
      // Unknown escapes pass through literally
      expect(result.stdout).toBe("\\z\\q\\x\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle double backslash in prompt", async () => {
      const env = new Bash();
      const result = await env.exec('x="a\\\\\\\\b"; echo "${x@P}"');
      // Each \\\\ becomes \\, then \\ becomes \
      expect(result.stdout).toBe("a\\b\n");
      expect(result.exitCode).toBe(0);
    });
  });
});
