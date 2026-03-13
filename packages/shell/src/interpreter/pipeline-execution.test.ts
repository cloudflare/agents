import { describe, expect, it } from "vitest";
import { Bash } from "../Shell";

describe("pipeline stderr propagation", () => {
  it("stderr from non-last command flows to parent", async () => {
    const result = await new Bash().exec("ls /no_such_path_xyz | cat");
    expect(result.stderr).toContain("No such file");
    expect(result.stdout).toBe("");
  });

  it("stderr from first command in 3-stage pipeline", async () => {
    const result = await new Bash().exec("ls /no_such_path_xyz | cat | cat");
    expect(result.stderr).toContain("No such file");
  });

  it("stderr from middle command in pipeline", async () => {
    const bash = new Bash();
    const result = await bash.exec("echo hello | ls /no_such_path_xyz | cat");
    expect(result.stderr).toContain("No such file");
  });

  it("stderr from last command in pipeline", async () => {
    const result = await new Bash().exec("echo hello | ls /no_such_path_xyz");
    expect(result.stderr).toContain("No such file");
  });

  it("stderr from multiple commands in same pipeline", async () => {
    const result = await new Bash().exec("ls /no_such_a | ls /no_such_b | cat");
    expect(result.stderr).toContain("No such file");
    // Both error messages should appear
    expect(result.stderr).toContain("no_such_a");
    expect(result.stderr).toContain("no_such_b");
  });

  it("stderr does not mix with stdout in regular pipe", async () => {
    const bash = new Bash({
      files: { "/data/file.txt": "hello\n" }
    });
    // First command produces both stdout and stderr
    const result = await bash.exec("ls /data/file.txt /no_such_xyz | cat");
    // stdout from ls flows through pipe to cat
    expect(result.stdout).toContain("/data/file.txt");
    // stderr goes to parent, not through pipe
    expect(result.stderr).toContain("No such file");
  });

  it("|& pipes both stdout and stderr (no stderr to parent)", async () => {
    const bash = new Bash();
    const result = await bash.exec("ls /no_such_path_xyz |& cat");
    // With |&, stderr goes through the pipe to cat's stdin,
    // cat outputs it as stdout
    expect(result.stdout).toContain("No such file");
    // stderr should be empty since it was piped
    expect(result.stderr).toBe("");
  });

  it("preserves exit code from last command", async () => {
    const result = await new Bash().exec("echo hello | grep nomatch");
    expect(result.exitCode).toBe(1);
  });

  it("stderr preserved with PIPESTATUS restore in tee wrapping", async () => {
    const bash = new Bash({
      files: { "/data/file.txt": "hello\n" }
    });
    // Simulate what tee plugin generates: cmd | tee file ; (exit ${PIPESTATUS[0]})
    const result = await bash.exec(
      "ls /data/file.txt /no_such_xyz | tee /tmp/out.txt; (exit ${PIPESTATUS[0]})"
    );
    expect(result.stdout).toContain("/data/file.txt");
    expect(result.stderr).toContain("No such file");
  });
});
