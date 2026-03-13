/**
 * sed security tests
 *
 * Verify that the 'e' command (shell execution) is blocked in sandboxed environment.
 */

import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("sed e command security", () => {
  it("should reject 'e' command with specified command", async () => {
    const bash = new Bash();
    const result = await bash.exec("echo hello | sed 'e whoami'");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      "e command (shell execution) is not supported"
    );
  });

  it("should reject 'e' command without arguments (execute pattern space)", async () => {
    const bash = new Bash();
    const result = await bash.exec("echo 'ls' | sed 'e'");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      "e command (shell execution) is not supported"
    );
  });

  it("should still allow normal sed operations", async () => {
    const bash = new Bash();
    const result = await bash.exec("echo hello | sed 's/hello/world/'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("world\n");
  });
});
