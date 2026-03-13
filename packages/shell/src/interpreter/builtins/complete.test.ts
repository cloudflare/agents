import { describe, expect, test } from "vitest";
import type { InterpreterContext, InterpreterState } from "../types";
import { handleComplete } from "./complete";

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

describe("complete builtin", () => {
  test("complete with no args and no specs", () => {
    const ctx = createMockCtx();
    const result = handleComplete(ctx, []);
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("complete -W sets wordlist completion", () => {
    const ctx = createMockCtx();
    const result = handleComplete(ctx, ["-W", "foo bar", "mycommand"]);
    expect(result.exitCode).toBe(0);
    expect(ctx.state.completionSpecs?.get("mycommand")).toEqual({
      wordlist: "foo bar"
    });
  });

  test("complete -p prints completions", () => {
    const ctx = createMockCtx();
    handleComplete(ctx, ["-W", "foo bar", "mycommand"]);
    const result = handleComplete(ctx, ["-p"]);
    expect(result.stdout).toBe("complete -W 'foo bar' mycommand\n");
    expect(result.exitCode).toBe(0);
  });

  test("complete with no args prints completions", () => {
    const ctx = createMockCtx();
    handleComplete(ctx, ["-W", "foo bar", "mycommand"]);
    const result = handleComplete(ctx, []);
    expect(result.stdout).toBe("complete -W 'foo bar' mycommand\n");
    expect(result.exitCode).toBe(0);
  });

  test("complete -F sets function completion", () => {
    const ctx = createMockCtx();
    const result = handleComplete(ctx, ["-F", "myfunc", "other"]);
    expect(result.exitCode).toBe(0);
    expect(ctx.state.completionSpecs?.get("other")).toEqual({
      function: "myfunc"
    });
  });

  test("complete prints both specs", () => {
    const ctx = createMockCtx();
    handleComplete(ctx, ["-W", "foo bar", "mycommand"]);
    handleComplete(ctx, ["-F", "myfunc", "other"]);
    const result = handleComplete(ctx, []);
    expect(result.stdout).toContain("complete -W 'foo bar' mycommand\n");
    expect(result.stdout).toContain("complete -F myfunc other\n");
    expect(result.exitCode).toBe(0);
  });

  test("complete -F without command is error", () => {
    const ctx = createMockCtx();
    const result = handleComplete(ctx, ["-F", "f"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("-F");
  });

  test("complete -o default -o nospace -F works", () => {
    const ctx = createMockCtx();
    const result = handleComplete(ctx, [
      "-o",
      "default",
      "-o",
      "nospace",
      "-F",
      "foo",
      "git"
    ]);
    expect(result.exitCode).toBe(0);
    expect(ctx.state.completionSpecs?.get("git")).toEqual({
      function: "foo",
      options: ["default", "nospace"]
    });
  });

  test("complete -r removes spec", () => {
    const ctx = createMockCtx();
    handleComplete(ctx, ["-W", "foo bar", "mycommand"]);
    handleComplete(ctx, ["-F", "myfunc", "other"]);
    handleComplete(ctx, ["-r", "mycommand"]);
    const result = handleComplete(ctx, []);
    expect(result.stdout).toBe("complete -F myfunc other\n");
    expect(ctx.state.completionSpecs?.has("mycommand")).toBe(false);
  });

  test("complete -D sets default completion", () => {
    const ctx = createMockCtx();
    const result = handleComplete(ctx, ["-F", "invalidZZ", "-D"]);
    expect(result.exitCode).toBe(0);
    expect(ctx.state.completionSpecs?.get("__default__")).toEqual({
      function: "invalidZZ",
      isDefault: true
    });
  });

  test("complete foo with no options is allowed (bash BUG behavior)", () => {
    const ctx = createMockCtx();
    const result = handleComplete(ctx, ["foo"]);
    expect(result.exitCode).toBe(0);
  });
});
