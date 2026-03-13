import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

// Note: Each exec is a new shell - aliases don't persist across execs
describe("alias command", () => {
  it("should list no aliases initially", async () => {
    const env = new Bash();
    const result = await env.exec("alias");
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should set and list an alias within same exec", async () => {
    const env = new Bash();
    const result = await env.exec("alias ll='ls -la'; alias");
    expect(result.stdout).toBe("alias ll='ls -la'\n");
    expect(result.exitCode).toBe(0);
  });

  it("should show a specific alias within same exec", async () => {
    const env = new Bash();
    const result = await env.exec("alias ll='ls -la'; alias ll");
    expect(result.stdout).toBe("alias ll='ls -la'\n");
    expect(result.exitCode).toBe(0);
  });

  it("should error when alias not found", async () => {
    const env = new Bash();
    const result = await env.exec("alias notexists");
    expect(result.stderr).toContain("not found");
    expect(result.exitCode).toBe(1);
  });

  it("should set multiple aliases within same exec", async () => {
    const env = new Bash();
    const result = await env.exec("alias ll='ls -la' la='ls -a'; alias");
    expect(result.stdout).toBe("alias ll='ls -la'\nalias la='ls -a'\n");
  });

  it("should show help with --help", async () => {
    const env = new Bash();
    const result = await env.exec("alias --help");
    expect(result.stdout).toContain("alias");
    expect(result.exitCode).toBe(0);
  });

  it("alias does not persist across exec calls", async () => {
    const env = new Bash();
    await env.exec("alias ll='ls -la'");
    // Each exec is a new shell - alias is not defined
    const result = await env.exec("alias ll");
    expect(result.stderr).toContain("not found");
    expect(result.exitCode).toBe(1);
  });
});

// Note: Alias expansion is NOT implemented to match real bash behavior.
// In non-interactive mode (scripts), bash does not expand aliases.
// The alias command only stores/lists alias definitions.

describe("unalias command", () => {
  it("should remove an alias within same exec", async () => {
    const env = new Bash();
    const result = await env.exec("alias ll='ls -la'; unalias ll; alias ll");
    expect(result.stderr).toContain("not found");
    expect(result.exitCode).toBe(1);
  });

  it("should error when unaliasing non-existent alias", async () => {
    const env = new Bash();
    const result = await env.exec("unalias notexists");
    expect(result.stderr).toContain("not found");
    expect(result.exitCode).toBe(1);
  });

  it("should remove all aliases with -a", async () => {
    const env = new Bash();
    const result = await env.exec(
      "alias ll='ls -la' la='ls -a'; unalias -a; alias"
    );
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should show help with --help", async () => {
    const env = new Bash();
    const result = await env.exec("unalias --help");
    expect(result.stdout).toContain("unalias");
    expect(result.exitCode).toBe(0);
  });
});
