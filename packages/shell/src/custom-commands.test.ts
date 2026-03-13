import { describe, expect, it } from "vitest";
import { Bash } from "./Shell";
import {
  type CustomCommand,
  createLazyCustomCommand,
  defineCommand,
  isLazyCommand,
  type LazyCommand
} from "./custom-commands";
import type { Command } from "./types";

describe("custom-commands", () => {
  describe("defineCommand", () => {
    it("creates a Command object with name and execute", () => {
      const cmd = defineCommand("test", async () => ({
        stdout: "hello\n",
        stderr: "",
        exitCode: 0
      }));

      expect(cmd.name).toBe("test");
      expect(typeof cmd.execute).toBe("function");
    });

    it("execute function receives args and ctx", async () => {
      const cmd = defineCommand("greet", async (args, ctx) => ({
        stdout: `Hello, ${args[0] || "world"}! CWD: ${ctx.cwd}\n`,
        stderr: "",
        exitCode: 0
      }));

      const bash = new Bash({ customCommands: [cmd] });
      const result = await bash.exec("greet Alice");

      expect(result.stdout).toBe("Hello, Alice! CWD: /home/user\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("isLazyCommand", () => {
    it("returns true for LazyCommand objects", () => {
      const lazy: LazyCommand = {
        name: "lazy",
        load: async () => ({
          name: "lazy",
          execute: async () => ({ stdout: "", stderr: "", exitCode: 0 })
        })
      };
      expect(isLazyCommand(lazy)).toBe(true);
    });

    it("returns false for Command objects", () => {
      const cmd: Command = {
        name: "cmd",
        execute: async () => ({ stdout: "", stderr: "", exitCode: 0 })
      };
      expect(isLazyCommand(cmd)).toBe(false);
    });
  });

  describe("createLazyCustomCommand", () => {
    it("creates a command that loads on first execution", async () => {
      let loadCount = 0;
      const lazy: LazyCommand = {
        name: "lazy-test",
        load: async () => {
          loadCount++;
          return defineCommand("lazy-test", async () => ({
            stdout: "lazy loaded\n",
            stderr: "",
            exitCode: 0
          }));
        }
      };

      const cmd = createLazyCustomCommand(lazy);
      expect(loadCount).toBe(0);

      // First execution loads the command
      const result1 = await cmd.execute([], {
        fs: {} as never,
        cwd: "/",
        env: new Map(),
        stdin: ""
      });
      expect(loadCount).toBe(1);
      expect(result1.stdout).toBe("lazy loaded\n");

      // Second execution uses cached command
      const result2 = await cmd.execute([], {
        fs: {} as never,
        cwd: "/",
        env: new Map(),
        stdin: ""
      });
      expect(loadCount).toBe(1);
      expect(result2.stdout).toBe("lazy loaded\n");
    });
  });

  describe("Bash with customCommands", () => {
    it("registers and executes a simple custom command", async () => {
      const hello = defineCommand("hello", async (args) => ({
        stdout: `Hello, ${args[0] || "world"}!\n`,
        stderr: "",
        exitCode: 0
      }));

      const bash = new Bash({ customCommands: [hello] });
      const result = await bash.exec("hello");

      expect(result.stdout).toBe("Hello, world!\n");
      expect(result.exitCode).toBe(0);
    });

    it("custom command receives stdin from pipe", async () => {
      const wordcount = defineCommand("wordcount", async (_args, ctx) => {
        const words = ctx.stdin.trim().split(/\s+/).filter(Boolean).length;
        return { stdout: `${words}\n`, stderr: "", exitCode: 0 };
      });

      const bash = new Bash({ customCommands: [wordcount] });
      const result = await bash.exec("echo 'one two three' | wordcount");

      expect(result.stdout).toBe("3\n");
      expect(result.exitCode).toBe(0);
    });

    it("custom command can read files via ctx.fs", async () => {
      const reader = defineCommand("reader", async (args, ctx) => {
        const content = await ctx.fs.readFile(args[0]);
        return { stdout: content, stderr: "", exitCode: 0 };
      });

      const bash = new Bash({
        customCommands: [reader],
        files: { "/test.txt": "file content" }
      });
      const result = await bash.exec("reader /test.txt");

      expect(result.stdout).toBe("file content");
      expect(result.exitCode).toBe(0);
    });

    it("custom command can access environment variables", async () => {
      const showenv = defineCommand("showenv", async (args, ctx) => ({
        stdout: `${args[0]}=${ctx.env.get(args[0]) || ""}\n`,
        stderr: "",
        exitCode: 0
      }));

      const bash = new Bash({
        customCommands: [showenv],
        env: { MY_VAR: "my_value" }
      });
      const result = await bash.exec("showenv MY_VAR");

      expect(result.stdout).toBe("MY_VAR=my_value\n");
      expect(result.exitCode).toBe(0);
    });

    it("custom command overrides built-in command", async () => {
      const customEcho = defineCommand("echo", async (args) => ({
        stdout: `Custom: ${args.join(" ")}\n`,
        stderr: "",
        exitCode: 0
      }));

      const bash = new Bash({ customCommands: [customEcho] });
      const result = await bash.exec("echo hello world");

      expect(result.stdout).toBe("Custom: hello world\n");
      expect(result.exitCode).toBe(0);
    });

    it("registers lazy-loaded custom command", async () => {
      let loaded = false;
      const lazyCmd: LazyCommand = {
        name: "lazy-hello",
        load: async () => {
          loaded = true;
          return defineCommand("lazy-hello", async () => ({
            stdout: "lazy hello!\n",
            stderr: "",
            exitCode: 0
          }));
        }
      };

      const bash = new Bash({ customCommands: [lazyCmd] });
      expect(loaded).toBe(false);

      const result = await bash.exec("lazy-hello");
      expect(loaded).toBe(true);
      expect(result.stdout).toBe("lazy hello!\n");
      expect(result.exitCode).toBe(0);
    });

    it("multiple custom commands can be registered", async () => {
      const cmd1 = defineCommand("cmd1", async () => ({
        stdout: "one\n",
        stderr: "",
        exitCode: 0
      }));
      const cmd2 = defineCommand("cmd2", async () => ({
        stdout: "two\n",
        stderr: "",
        exitCode: 0
      }));

      const bash = new Bash({ customCommands: [cmd1, cmd2] });

      const result1 = await bash.exec("cmd1");
      expect(result1.stdout).toBe("one\n");

      const result2 = await bash.exec("cmd2");
      expect(result2.stdout).toBe("two\n");
    });

    it("custom command can return non-zero exit code", async () => {
      const failing = defineCommand("failing", async () => ({
        stdout: "",
        stderr: "error occurred\n",
        exitCode: 42
      }));

      const bash = new Bash({ customCommands: [failing] });
      const result = await bash.exec("failing");

      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("error occurred\n");
      expect(result.exitCode).toBe(42);
    });

    it("custom command works in pipeline with built-in commands", async () => {
      const upper = defineCommand("upper", async (_args, ctx) => ({
        stdout: ctx.stdin.toUpperCase(),
        stderr: "",
        exitCode: 0
      }));

      const bash = new Bash({ customCommands: [upper] });
      const result = await bash.exec("echo 'hello world' | upper | cat");

      expect(result.stdout).toBe("HELLO WORLD\n");
      expect(result.exitCode).toBe(0);
    });

    it("custom command can use exec to run subcommands", async () => {
      const wrapper = defineCommand("wrapper", async (args, ctx) => {
        if (!ctx.exec) {
          return { stdout: "", stderr: "exec not available\n", exitCode: 1 };
        }
        const subResult = await ctx.exec(args.join(" "), { cwd: ctx.cwd });
        return {
          stdout: `[wrapped] ${subResult.stdout}`,
          stderr: subResult.stderr,
          exitCode: subResult.exitCode
        };
      });

      const bash = new Bash({ customCommands: [wrapper] });
      const result = await bash.exec("wrapper echo hello");

      expect(result.stdout).toBe("[wrapped] hello\n");
      expect(result.exitCode).toBe(0);
    });

    it("works with mixed Command and LazyCommand types", async () => {
      const regular = defineCommand("regular", async () => ({
        stdout: "regular\n",
        stderr: "",
        exitCode: 0
      }));

      const lazy: CustomCommand = {
        name: "lazy",
        load: async () =>
          defineCommand("lazy", async () => ({
            stdout: "lazy\n",
            stderr: "",
            exitCode: 0
          }))
      };

      const bash = new Bash({ customCommands: [regular, lazy] });

      expect((await bash.exec("regular")).stdout).toBe("regular\n");
      expect((await bash.exec("lazy")).stdout).toBe("lazy\n");
    });
  });
});
