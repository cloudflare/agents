import { describe, expect, it } from "vitest";
import { Bash } from "../Shell";

describe("Bash Syntax - set -e (errexit)", () => {
  describe("basic errexit behavior", () => {
    it("should exit immediately when command fails with set -e", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -e
        echo before
        false
        echo after
      `);
      expect(result.stdout).toBe("before\n");
      expect(result.exitCode).toBe(1);
    });

    it("should continue execution without set -e", async () => {
      const env = new Bash();
      const result = await env.exec(`
        echo before
        false
        echo after
      `);
      expect(result.stdout).toBe("before\nafter\n");
      expect(result.exitCode).toBe(0);
    });

    it("should not exit if command succeeds", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -e
        echo one
        true
        echo two
      `);
      expect(result.stdout).toBe("one\ntwo\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("set +e disables errexit", () => {
    it("should disable errexit with set +e", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -e
        set +e
        echo before
        false
        echo after
      `);
      expect(result.stdout).toBe("before\nafter\n");
      expect(result.exitCode).toBe(0);
    });

    it("should re-enable errexit after set +e", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -e
        set +e
        false
        set -e
        echo before
        false
        echo after
      `);
      expect(result.stdout).toBe("before\n");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("set -o errexit syntax", () => {
    it("should enable errexit with set -o errexit", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -o errexit
        echo before
        false
        echo after
      `);
      expect(result.stdout).toBe("before\n");
      expect(result.exitCode).toBe(1);
    });

    it("should disable errexit with set +o errexit", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -o errexit
        set +o errexit
        echo before
        false
        echo after
      `);
      expect(result.stdout).toBe("before\nafter\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("errexit exceptions - && and ||", () => {
    it("should not exit on failed command in && short-circuit", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -e
        false && echo "not reached"
        echo after
      `);
      expect(result.stdout).toBe("after\n");
      expect(result.exitCode).toBe(0);
    });

    it("should not exit on failed command in || short-circuit", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -e
        false || echo "fallback"
        echo after
      `);
      expect(result.stdout).toBe("fallback\nafter\n");
      expect(result.exitCode).toBe(0);
    });

    it("should exit if final command in && list fails", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -e
        echo before
        true && false
        echo after
      `);
      expect(result.stdout).toBe("before\n");
      expect(result.exitCode).toBe(1);
    });

    it("should not exit if || succeeds after && fails", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -e
        false && echo "skip" || echo "fallback"
        echo after
      `);
      expect(result.stdout).toBe("fallback\nafter\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("errexit exceptions - negated commands", () => {
    it("should not exit on negated successful command", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -e
        ! true
        echo after
      `);
      expect(result.stdout).toBe("after\n");
      expect(result.exitCode).toBe(0);
    });

    it("should not exit on negated failed command", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -e
        ! false
        echo after
      `);
      expect(result.stdout).toBe("after\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("errexit exceptions - if condition", () => {
    it("should not exit on failed command in if condition", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -e
        if false; then
          echo "then"
        else
          echo "else"
        fi
        echo after
      `);
      expect(result.stdout).toBe("else\nafter\n");
      expect(result.exitCode).toBe(0);
    });

    it("should exit on failed command in if body", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -e
        if true; then
          echo "in body"
          false
          echo "not reached"
        fi
        echo after
      `);
      expect(result.stdout).toBe("in body\n");
      expect(result.exitCode).toBe(1);
    });

    it("should not exit on failed command in elif condition", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -e
        if false; then
          echo one
        elif false; then
          echo two
        else
          echo three
        fi
        echo after
      `);
      expect(result.stdout).toBe("three\nafter\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("errexit exceptions - while condition", () => {
    it("should not exit on failed condition that terminates loop", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -e
        x=0
        while [ $x -lt 3 ]; do
          echo $x
          x=$((x + 1))
        done
        echo after
      `);
      expect(result.stdout).toBe("0\n1\n2\nafter\n");
      expect(result.exitCode).toBe(0);
    });

    it("should exit on failed command in while body", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -e
        x=0
        while [ $x -lt 3 ]; do
          echo $x
          false
          x=$((x + 1))
        done
        echo after
      `);
      expect(result.stdout).toBe("0\n");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("errexit exceptions - until condition", () => {
    it("should not exit on failed condition during loop", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -e
        x=0
        until [ $x -ge 3 ]; do
          echo $x
          x=$((x + 1))
        done
        echo after
      `);
      expect(result.stdout).toBe("0\n1\n2\nafter\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("combined flags", () => {
    it("should handle -ee combined flag (multiple e)", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -ee
        echo before
        false
        echo after
      `);
      expect(result.stdout).toBe("before\n");
      expect(result.exitCode).toBe(1);
    });

    it("should error on unknown combined flag", async () => {
      const env = new Bash();
      // Use -ze (z is invalid) so the error happens before errexit is enabled
      const result = await env.exec("set -ze");
      expect(result.exitCode).toBe(1); // implementation returns 1 for invalid options
      expect(result.stderr).toContain("-z");
      expect(result.stderr).toContain("invalid option");
    });

    it("should trigger errexit when set -ez fails on z", async () => {
      const env = new Bash();
      // With -ez, errexit is enabled first, then z fails - errexit kicks in
      const result = await env.exec(`
        set -ez
        echo "should not reach"
      `);
      // Command fails with exit code 1 for invalid option
      expect(result.exitCode).toBe(1);
      // No echo output because script exited on the set command failure
      expect(result.stdout).toBe("");
    });
  });

  describe("preserves exit code", () => {
    it("should preserve non-zero exit code", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -e
        exit 42
      `);
      expect(result.exitCode).toBe(42);
    });
  });

  describe("error handling", () => {
    it("should show help with --help", async () => {
      const env = new Bash();
      const result = await env.exec("set --help");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("usage:");
      expect(result.stdout).toContain("-e");
      expect(result.stdout).toContain("errexit");
    });

    it("should error on unknown short option", async () => {
      const env = new Bash();
      const result = await env.exec("set -z");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("-z");
      expect(result.stderr).toContain("invalid option");
    });

    it("should error on unknown long option", async () => {
      const env = new Bash();
      const result = await env.exec("set -o unknownoption");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("unknownoption");
      expect(result.stderr).toContain("invalid option name");
    });

    it("should list options when -o has no argument", async () => {
      // In bash, `set -o` without argument lists all options
      const env = new Bash();
      const result = await env.exec("set -o");
      expect(result.exitCode).toBe(0);
      // Should output option status (e.g., "errexit off")
      expect(result.stdout).toContain("errexit");
    });

    it("should list options when +o has no argument", async () => {
      // In bash, `set +o` without argument outputs commands to recreate settings
      const env = new Bash();
      const result = await env.exec("set +o");
      expect(result.exitCode).toBe(0);
      // Should output set commands (e.g., "set +o errexit")
      expect(result.stdout).toContain("set");
    });
  });
});
