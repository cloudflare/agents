import { describe, expect, test } from "vitest";
import type { InterpreterContext, InterpreterState } from "../types";
import { handleComplete } from "./complete";
import { handleCompopt } from "./compopt";

// Minimal mock for testing
function createMockCtx(): InterpreterContext {
  const state: InterpreterState = {
    env: new Map(),
    cwd: "/",
    previousDir: "/",
    functions: new Map(),
    localScopes: [],
    callDepth: 0,
    sourceDepth: 0,
    commandCount: 0,
    lastExitCode: 0,
    lastArg: "",
    startTime: Date.now(),
    lastBackgroundPid: 0,
    bashPid: 1,
    nextVirtualPid: 2,
    virtualPid: 1,
    virtualPpid: 0,
    virtualUid: 1000,
    virtualGid: 1000,
    currentLine: 0,
    options: {
      errexit: false,
      pipefail: false,
      nounset: false,
      xtrace: false,
      verbose: false,
      posix: false,
      allexport: false,
      noclobber: false,
      noglob: false,
      noexec: false,
      vi: false,
      emacs: false
    },
    shoptOptions: {
      extglob: false,
      dotglob: false,
      nullglob: false,
      failglob: false,
      globstar: false,
      globskipdots: true,
      nocaseglob: false,
      nocasematch: false,
      expand_aliases: false,
      lastpipe: false,
      xpg_echo: false
    },
    inCondition: false,
    loopDepth: 0
  };

  return {
    state,
    fs: {} as unknown as InterpreterContext["fs"],
    commands: {} as unknown as InterpreterContext["commands"],
    limits: {} as unknown as InterpreterContext["limits"],
    execFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    executeScript: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    executeStatement: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    executeCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 })
  };
}

describe("compopt builtin", () => {
  test("compopt with invalid option returns exit code 2", () => {
    const ctx = createMockCtx();
    const result = handleCompopt(ctx, ["-o", "invalid"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("invalid");
    expect(result.stderr).toContain("invalid option name");
  });

  test("compopt without command name outside completion function returns exit code 1", () => {
    const ctx = createMockCtx();
    const result = handleCompopt(ctx, ["-o", "filenames", "+o", "nospace"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "not currently executing completion function"
    );
  });

  test("compopt -D modifies default completion options", () => {
    const ctx = createMockCtx();
    // First set up a default completion
    handleComplete(ctx, ["-F", "myfunc", "-D"]);

    // Now modify its options
    const result = handleCompopt(ctx, [
      "-D",
      "-o",
      "nospace",
      "-o",
      "filenames"
    ]);
    expect(result.exitCode).toBe(0);

    const spec = ctx.state.completionSpecs?.get("__default__");
    expect(spec).toBeDefined();
    expect(spec?.options).toContain("nospace");
    expect(spec?.options).toContain("filenames");
  });

  test("compopt -E modifies empty-line completion options", () => {
    const ctx = createMockCtx();
    const result = handleCompopt(ctx, ["-E", "-o", "default"]);
    expect(result.exitCode).toBe(0);

    const spec = ctx.state.completionSpecs?.get("__empty__");
    expect(spec).toBeDefined();
    expect(spec?.options).toContain("default");
  });

  test("compopt with command name modifies that command's options", () => {
    const ctx = createMockCtx();
    // First set up a completion for git
    handleComplete(ctx, ["-F", "gitfunc", "git"]);

    // Now modify its options
    const result = handleCompopt(ctx, ["-o", "nospace", "git"]);
    expect(result.exitCode).toBe(0);

    const spec = ctx.state.completionSpecs?.get("git");
    expect(spec).toBeDefined();
    expect(spec?.options).toContain("nospace");
    expect(spec?.function).toBe("gitfunc"); // Original function preserved
  });

  test("compopt +o disables options", () => {
    const ctx = createMockCtx();
    // Set up a completion with options
    handleComplete(ctx, [
      "-o",
      "nospace",
      "-o",
      "filenames",
      "-F",
      "myfunc",
      "cmd"
    ]);

    // Disable nospace
    const result = handleCompopt(ctx, ["+o", "nospace", "cmd"]);
    expect(result.exitCode).toBe(0);

    const spec = ctx.state.completionSpecs?.get("cmd");
    expect(spec).toBeDefined();
    expect(spec?.options).not.toContain("nospace");
    expect(spec?.options).toContain("filenames");
  });

  test("compopt can enable and disable options at once", () => {
    const ctx = createMockCtx();
    // Set up a completion with some options
    handleComplete(ctx, ["-o", "nospace", "-F", "myfunc", "cmd"]);

    // Enable filenames, disable nospace
    const result = handleCompopt(ctx, [
      "-o",
      "filenames",
      "+o",
      "nospace",
      "cmd"
    ]);
    expect(result.exitCode).toBe(0);

    const spec = ctx.state.completionSpecs?.get("cmd");
    expect(spec).toBeDefined();
    expect(spec?.options).toContain("filenames");
    expect(spec?.options).not.toContain("nospace");
  });

  test("compopt creates spec for command that doesn't have one", () => {
    const ctx = createMockCtx();
    const result = handleCompopt(ctx, ["-o", "nospace", "newcmd"]);
    expect(result.exitCode).toBe(0);

    const spec = ctx.state.completionSpecs?.get("newcmd");
    expect(spec).toBeDefined();
    expect(spec?.options).toContain("nospace");
  });

  test("compopt -o without argument returns error", () => {
    const ctx = createMockCtx();
    const result = handleCompopt(ctx, ["-o"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("-o");
    expect(result.stderr).toContain("option requires an argument");
  });

  test("compopt +o without argument returns error", () => {
    const ctx = createMockCtx();
    const result = handleCompopt(ctx, ["+o"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("+o");
    expect(result.stderr).toContain("option requires an argument");
  });

  test("compopt validates all option names", () => {
    const ctx = createMockCtx();

    // Test all valid options
    const validOptions = [
      "bashdefault",
      "default",
      "dirnames",
      "filenames",
      "noquote",
      "nosort",
      "nospace",
      "plusdirs"
    ];

    for (const opt of validOptions) {
      const result = handleCompopt(ctx, ["-o", opt, "testcmd"]);
      expect(result.exitCode).toBe(0);
    }

    // Test invalid option
    const invalid = handleCompopt(ctx, ["-o", "notanoption", "testcmd"]);
    expect(invalid.exitCode).toBe(2);
  });
});
