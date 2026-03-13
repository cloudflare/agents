import { describe, expect, it } from "vitest";
import { Bash } from "../Shell";

describe("Bash Syntax - set -o pipefail", () => {
  describe("basic pipefail behavior", () => {
    it("should return success when all commands succeed", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -o pipefail
        echo hello | cat | cat
        echo "exit: $?"
      `);
      expect(result.stdout).toBe("hello\nexit: 0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should return failure when first command fails", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -o pipefail
        false | true
        echo "exit: $?"
      `);
      expect(result.stdout).toBe("exit: 1\n");
      expect(result.exitCode).toBe(0);
    });

    it("should return failure when middle command fails", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -o pipefail
        echo hello | false | cat
        echo "exit: $?"
      `);
      expect(result.stdout).toBe("exit: 1\n");
      expect(result.exitCode).toBe(0);
    });

    it("should return rightmost failing exit code", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -o pipefail
        exit 2 | exit 3 | true
        echo "exit: $?"
      `);
      expect(result.stdout).toBe("exit: 3\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("without pipefail", () => {
    it("should return last command exit code without pipefail", async () => {
      const env = new Bash();
      const result = await env.exec(`
        false | true
        echo "exit: $?"
      `);
      expect(result.stdout).toBe("exit: 0\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("disable pipefail", () => {
    it("should disable pipefail with +o pipefail", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -o pipefail
        set +o pipefail
        false | true
        echo "exit: $?"
      `);
      expect(result.stdout).toBe("exit: 0\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("pipefail with errexit", () => {
    it("should trigger errexit when pipeline fails with pipefail", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -e
        set -o pipefail
        echo before
        false | true
        echo after
      `);
      expect(result.stdout).toBe("before\n");
      expect(result.exitCode).toBe(1);
    });

    it("should not trigger errexit without pipefail", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -e
        echo before
        false | true
        echo after
      `);
      expect(result.stdout).toBe("before\nafter\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("single command", () => {
    it("should work with single command pipeline", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -o pipefail
        false
        echo "exit: $?"
      `);
      expect(result.stdout).toBe("exit: 1\n");
      expect(result.exitCode).toBe(0);
    });
  });
});
