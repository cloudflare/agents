import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("POSIX mode fatal errors", () => {
  it("shift with too many args is fatal in POSIX mode", async () => {
    const bash = new Bash();
    const result = await bash.exec(`
set -o posix
set -- a b
shift 3
echo status=$?
`);
    // Should NOT print "status=..." because shift should cause script to exit
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("shift");
    expect(result.exitCode).toBe(1);
  });

  it("set with invalid option is fatal in POSIX mode", async () => {
    const bash = new Bash();
    const result = await bash.exec(`
set -o posix
shopt -s invalid_ || true
echo ok
set -o invalid_ || true
echo should not get here
`);
    // Should print "ok" (shopt is not special) but not "should not get here"
    expect(result.stdout).toContain("ok");
    expect(result.stdout).not.toContain("should not get here");
    expect(result.exitCode).toBe(1);
  });

  it("shift works normally without POSIX mode", async () => {
    const bash = new Bash();
    const result = await bash.exec(`
set -- a b
shift 3
echo status=$?
`);
    // Without POSIX mode, shift error should NOT be fatal
    expect(result.stdout).toContain("status=1");
    expect(result.exitCode).toBe(0);
  });

  // Tests matching the spec-test format exactly
  it("Shift is special and fails whole script (spec-test format)", async () => {
    const bash = new Bash({ env: { BASH_VERSION: "5.0" } });
    // This is the actual spec test script
    const result = await bash.exec(`
if test -n "$BASH_VERSION"; then
  set -o posix
fi
set -- a b
shift 3
echo status=$?
`);
    // The outer script checks if the exit code is non-zero
    // Expected stdout: (nothing - "echo status=$?" should not run)
    // Expected exit code: non-zero
    expect(result.stdout).toBe("");
    expect(result.exitCode).not.toBe(0);
  });

  it("set is special and fails whole script (spec-test format)", async () => {
    const bash = new Bash({ env: { BASH_VERSION: "5.0" } });
    const result = await bash.exec(`
if test -n "$BASH_VERSION"; then
  set -o posix
fi

shopt -s invalid_ || true
echo ok
set -o invalid_ || true
echo should not get here
`);
    // Expected: "ok\n" only (not "should not get here")
    // Exit code: non-zero
    expect(result.stdout).toBe("ok\n");
    expect(result.exitCode).not.toBe(0);
  });
});
