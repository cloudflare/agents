import { describe, expect, it } from "vitest";
import { Bash } from "../Shell";
import { shellJoinArgs } from "./shell-quote";

describe("shellJoinArgs", () => {
  it("quotes simple tokens", () => {
    expect(shellJoinArgs(["echo", "hello"])).toBe("'echo' 'hello'");
  });

  it("handles empty array", () => {
    expect(shellJoinArgs([])).toBe("");
  });

  it("handles single arg", () => {
    expect(shellJoinArgs(["ls"])).toBe("'ls'");
  });

  it("preserves spaces inside arguments", () => {
    expect(shellJoinArgs(["echo", "hello world"])).toBe("'echo' 'hello world'");
  });

  it("escapes single quotes", () => {
    expect(shellJoinArgs(["echo", "it's"])).toBe("'echo' 'it'\\''s'");
  });

  it("handles empty string argument", () => {
    expect(shellJoinArgs(["echo", ""])).toBe("'echo' ''");
  });

  it("neutralizes shell metacharacters", () => {
    expect(shellJoinArgs(["echo", "$(whoami)"])).toBe("'echo' '$(whoami)'");
    expect(shellJoinArgs(["echo", "; rm -rf /"])).toBe("'echo' '; rm -rf /'");
    expect(shellJoinArgs(["echo", "`id`"])).toBe("'echo' '`id`'");
    expect(shellJoinArgs(["echo", "a|b"])).toBe("'echo' 'a|b'");
    expect(shellJoinArgs(["echo", "a&b"])).toBe("'echo' 'a&b'");
    expect(shellJoinArgs(["echo", "a>b"])).toBe("'echo' 'a>b'");
  });

  it("handles double quotes in arguments", () => {
    expect(shellJoinArgs(["echo", 'say "hi"'])).toBe("'echo' 'say \"hi\"'");
  });

  it("handles newlines and tabs", () => {
    expect(shellJoinArgs(["echo", "line1\nline2"])).toBe(
      "'echo' 'line1\nline2'"
    );
    expect(shellJoinArgs(["echo", "col1\tcol2"])).toBe("'echo' 'col1\tcol2'");
  });
});

describe("shellJoinArgs integration with Bash interpreter", () => {
  it("metacharacters are not interpreted", async () => {
    const bash = new Bash();
    const cmd = shellJoinArgs(["echo", "$(echo INJECTED)"]);
    const result = await bash.exec(cmd);
    expect(result.stdout).toBe("$(echo INJECTED)\n");
  });

  it("single quotes in args round-trip correctly", async () => {
    const bash = new Bash();
    const cmd = shellJoinArgs(["echo", "it's a test"]);
    const result = await bash.exec(cmd);
    expect(result.stdout).toBe("it's a test\n");
  });

  it("semicolons do not create new commands", async () => {
    const bash = new Bash();
    const cmd = shellJoinArgs(["echo", "safe; echo INJECTED"]);
    const result = await bash.exec(cmd);
    expect(result.stdout).toBe("safe; echo INJECTED\n");
  });

  it("empty string argument is preserved", async () => {
    const bash = new Bash();
    const cmd = shellJoinArgs(["printf", "%s|", "a", "", "b"]);
    const result = await bash.exec(cmd);
    expect(result.stdout).toBe("a||b|");
  });

  it("spaces in arguments are preserved", async () => {
    const bash = new Bash();
    const cmd = shellJoinArgs(["echo", "hello   world"]);
    const result = await bash.exec(cmd);
    expect(result.stdout).toBe("hello   world\n");
  });
});
