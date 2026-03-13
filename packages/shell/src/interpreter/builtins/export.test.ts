import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("export builtin", () => {
  describe("setting variables", () => {
    it("should set a variable with export NAME=value (within same exec)", async () => {
      const env = new Bash();
      const result = await env.exec("export FOO=bar; echo $FOO");
      expect(result.stdout).toBe("bar\n");
    });

    it("should set multiple variables", async () => {
      const env = new Bash();
      const result = await env.exec("export FOO=bar BAZ=qux; echo $FOO $BAZ");
      expect(result.stdout).toBe("bar qux\n");
    });

    it("should handle value with equals sign", async () => {
      const env = new Bash();
      const result = await env.exec(
        "export URL=http://example.com?foo=bar; echo $URL"
      );
      expect(result.stdout).toBe("http://example.com?foo=bar\n");
    });

    it("should create empty variable when NAME has no value", async () => {
      const env = new Bash();
      const result = await env.exec(
        'export EMPTY; test -z "$EMPTY" && echo empty'
      );
      expect(result.stdout).toBe("empty\n");
    });

    it("should preserve existing variable value with export NAME", async () => {
      const env = new Bash({ env: { EXISTING: "value" } });
      const result = await env.exec("export EXISTING; echo $EXISTING");
      expect(result.stdout).toBe("value\n");
    });

    it("export does not persist across exec calls", async () => {
      const env = new Bash();
      await env.exec("export FOO=bar");
      // Each exec is a new shell - FOO is not set
      const result = await env.exec("echo $FOO");
      expect(result.stdout).toBe("\n");
    });
  });

  describe("listing variables", () => {
    it("should list all exported variables with no args", async () => {
      const env = new Bash({ env: { FOO: "bar", BAZ: "qux" } });
      const result = await env.exec("export");
      expect(result.stdout).toContain('declare -x FOO="bar"');
      expect(result.stdout).toContain('declare -x BAZ="qux"');
    });

    it("should list all exported variables with -p", async () => {
      const env = new Bash({ env: { FOO: "bar" } });
      const result = await env.exec("export -p");
      expect(result.stdout).toContain('declare -x FOO="bar"');
    });

    it("should list newly exported variables within same exec", async () => {
      const env = new Bash();
      const result = await env.exec('export MSG="it\'s working"; export');
      expect(result.stdout).toContain("it's working");
    });

    it("should not list aliases", async () => {
      const env = new Bash({ env: { FOO: "bar" } });
      const result = await env.exec("alias ll='ls -la'; export");
      expect(result.stdout).not.toContain("BASH_ALIAS");
      expect(result.stdout).toContain("FOO");
    });
  });

  describe("un-exporting with -n", () => {
    it("should remove export attribute but keep value with -n", async () => {
      const env = new Bash({ env: { FOO: "bar" } });
      // export -n removes the export attribute but keeps the value
      const result = await env.exec('export -n FOO; echo "$FOO"');
      expect(result.stdout).toBe("bar\n");
    });

    it("should remove export attribute from multiple variables with -n", async () => {
      const env = new Bash({ env: { FOO: "bar", BAZ: "qux" } });
      // export -n removes export attribute but keeps values
      const result = await env.exec('export -n FOO BAZ; echo "$FOO $BAZ"');
      expect(result.stdout).toBe("bar qux\n");
    });
  });

  describe("variable usage", () => {
    it("exported variable should be available in same exec", async () => {
      const env = new Bash();
      const result = await env.exec(
        "export GREETING=hello; echo $GREETING world"
      );
      expect(result.stdout).toBe("hello world\n");
    });

    it("exported variable should be available in subshell", async () => {
      const env = new Bash();
      const result = await env.exec("export FOO=bar; (echo $FOO)");
      expect(result.stdout).toBe("bar\n");
    });

    it("should work with conditional", async () => {
      const env = new Bash();
      const result = await env.exec(
        'export DEBUG=1; [ "$DEBUG" = "1" ] && echo debug_on'
      );
      expect(result.stdout).toBe("debug_on\n");
    });

    it("initial env vars are available in every exec", async () => {
      const env = new Bash({ env: { SHARED: "value" } });
      const result1 = await env.exec("echo $SHARED");
      const result2 = await env.exec("echo $SHARED");
      expect(result1.stdout).toBe("value\n");
      expect(result2.stdout).toBe("value\n");
    });
  });
});
