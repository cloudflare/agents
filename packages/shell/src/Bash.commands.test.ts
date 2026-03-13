import { describe, expect, it } from "vitest";
import { Bash } from "./Shell";
import { getCommandNames } from "./commands/registry";

describe("Bash commands filtering", () => {
  it("registers all commands by default", async () => {
    const env = new Bash();

    // Check that common commands are available
    const echoResult = await env.exec("echo hello");
    expect(echoResult.exitCode).toBe(0);

    const lsResult = await env.exec("ls /");
    expect(lsResult.exitCode).toBe(0);

    const grepResult = await env.exec("echo test | grep test");
    expect(grepResult.exitCode).toBe(0);
  });

  it("only registers specified commands", async () => {
    const env = new Bash({
      commands: ["echo", "cat"]
    });

    // These should work
    const echoResult = await env.exec("echo hello");
    expect(echoResult.exitCode).toBe(0);
    expect(echoResult.stdout).toBe("hello\n");

    const catResult = await env.exec("echo test | cat");
    expect(catResult.exitCode).toBe(0);

    // ls should not be available
    const lsResult = await env.exec("ls");
    expect(lsResult.exitCode).toBe(127);
    expect(lsResult.stderr).toContain("command not found");
  });

  it("grep is not available when not in commands list", async () => {
    const env = new Bash({
      commands: ["echo", "cat"]
    });

    const result = await env.exec("echo test | grep test");
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("command not found");
  });

  it("getCommandNames returns all available command names", () => {
    const names = getCommandNames();
    expect(names).toContain("echo");
    expect(names).toContain("cat");
    expect(names).toContain("ls");
    expect(names).toContain("grep");
    expect(names).toContain("find");
    // curl is a network command, not in the default list
    expect(names).not.toContain("curl");
  });

  it("empty commands array means no commands", async () => {
    const env = new Bash({
      commands: []
    });

    const result = await env.exec("echo hello");
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("command not found");
  });

  it("can use a subset of file commands", async () => {
    const env = new Bash({
      commands: ["ls", "cat", "mkdir"],
      files: { "/test.txt": "hello" }
    });

    // These should work
    expect((await env.exec("ls /")).exitCode).toBe(0);
    expect((await env.exec("cat /test.txt")).stdout).toBe("hello");
    expect((await env.exec("mkdir /newdir")).exitCode).toBe(0);

    // These should not work
    expect((await env.exec("rm /test.txt")).exitCode).toBe(127);
    expect((await env.exec("cp /test.txt /test2.txt")).exitCode).toBe(127);
  });

  it("custom commands can use Node.js APIs with defense-in-depth enabled", async () => {
    const env = new Bash({
      customCommands: [
        {
          name: "myfetch",
          execute: async (_args, _ctx) => {
            // Custom command uses setTimeout and fetch — both are blocked
            // globals, but should work because commands are trusted.
            await new Promise((r) => setTimeout(r, 1));
            return { stdout: "custom-ok\n", stderr: "", exitCode: 0 };
          }
        }
      ]
    });

    const result = await env.exec("myfetch");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("custom-ok\n");
  });
});
