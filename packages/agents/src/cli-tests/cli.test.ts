import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createCli } from "../cli/create";

describe("agents CLI", () => {
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;
  let originalProcessExit: typeof process.exit;
  let consoleOutput: string[] = [];
  let consoleError: string[] = [];
  let exitCode: number | null = null;

  beforeEach(() => {
    consoleOutput = [];
    consoleError = [];
    exitCode = null;
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    originalProcessExit = process.exit;

    // Capture console.log output
    console.log = vi.fn((...args) => {
      consoleOutput.push(args.map(String).join(" "));
    });

    // Capture console.error output
    console.error = vi.fn((...args) => {
      consoleError.push(args.map(String).join(" "));
    });

    // Capture process.exit calls (yargs calls this, so we need to handle it)
    process.exit = vi.fn((code?: number) => {
      exitCode = code ?? 0;
      // Don't actually exit in tests - throw to stop execution
      throw new Error(`process.exit(${code ?? 0})`);
    }) as unknown as typeof process.exit;
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    process.exit = originalProcessExit;
  });

  describe("init command", () => {
    it("should execute init command", async () => {
      const cli = createCli(["node", "cli.js", "init"]).exitProcess(false);
      try {
        await cli.parse();
      } catch (error) {
        // process.exit throws, which is expected
        if ((error as Error).message === "process.exit(0)") {
          // This is expected, continue
        } else {
          throw error;
        }
      }
      expect(consoleOutput).toContain("agents init: not implemented yet");
      expect(exitCode).toBe(0);
    });

    it("should execute create alias command", async () => {
      const cli = createCli(["node", "cli.js", "create"]).exitProcess(false);
      try {
        await cli.parse();
      } catch (error) {
        // process.exit throws, which is expected
        if ((error as Error).message === "process.exit(0)") {
          // This is expected, continue
        } else {
          throw error;
        }
      }
      expect(consoleOutput).toContain("agents init: not implemented yet");
      expect(exitCode).toBe(0);
    });

    it("should show init in help", async () => {
      const cli = createCli(["node", "cli.js", "init", "--help"]);
      try {
        await cli.parse();
      } catch (error) {
        // process.exit throws, which is expected for help
        expect((error as Error).message).toBe("process.exit(0)");
      }
      const allOutput = [...consoleOutput, ...consoleError].join("\n");
      expect(allOutput).toContain("Initialize an agents project");
    });
  });

  describe("dev command", () => {
    it("should execute dev command", async () => {
      const cli = createCli(["node", "cli.js", "dev"]).exitProcess(false);
      try {
        await cli.parse();
      } catch (error) {
        // process.exit throws, which is expected
        if ((error as Error).message === "process.exit(0)") {
          // This is expected, continue
        } else {
          throw error;
        }
      }
      expect(consoleOutput).toContain("agents dev: not implemented yet");
      expect(exitCode).toBe(0);
    });

    it("should show dev in help", async () => {
      const cli = createCli(["node", "cli.js", "dev", "--help"]);
      try {
        await cli.parse();
      } catch (error) {
        // process.exit throws, which is expected for help
        expect((error as Error).message).toBe("process.exit(0)");
      }
      const allOutput = [...consoleOutput, ...consoleError].join("\n");
      expect(allOutput).toContain("Start development server");
    });
  });

  describe("deploy command", () => {
    it("should execute deploy command", async () => {
      const cli = createCli(["node", "cli.js", "deploy"]).exitProcess(false);
      try {
        await cli.parse();
      } catch (error) {
        // process.exit throws, which is expected
        if ((error as Error).message === "process.exit(0)") {
          // This is expected, continue
        } else {
          throw error;
        }
      }
      expect(consoleOutput).toContain("agents deploy: not implemented yet");
      expect(exitCode).toBe(0);
    });

    it("should show deploy in help", async () => {
      const cli = createCli(["node", "cli.js", "deploy", "--help"]);
      try {
        await cli.parse();
      } catch (error) {
        // process.exit throws, which is expected for help
        expect((error as Error).message).toBe("process.exit(0)");
      }
      const allOutput = [...consoleOutput, ...consoleError].join("\n");
      expect(allOutput).toContain("Deploy agents to Cloudflare");
    });
  });

  describe("mcp command", () => {
    it("should execute mcp command", async () => {
      const cli = createCli(["node", "cli.js", "mcp"]).exitProcess(false);
      try {
        await cli.parse();
      } catch (error) {
        // process.exit throws, which is expected
        if ((error as Error).message === "process.exit(0)") {
          // This is expected, continue
        } else {
          throw error;
        }
      }
      expect(consoleOutput).toContain("agents mcp: not implemented yet");
      expect(exitCode).toBe(0);
    });

    it("should show mcp in help", async () => {
      const cli = createCli(["node", "cli.js", "mcp", "--help"]);
      try {
        await cli.parse();
      } catch (error) {
        // process.exit throws, which is expected for help
        expect((error as Error).message).toBe("process.exit(0)");
      }
      const allOutput = [...consoleOutput, ...consoleError].join("\n");
      expect(allOutput).toContain("The agents mcp server");
    });
  });

  describe("help and error handling", () => {
    it("should show general help", async () => {
      const cli = createCli(["node", "cli.js", "--help"]);
      try {
        await cli.parse();
      } catch (error) {
        // process.exit throws, which is expected for help
        expect((error as Error).message).toBe("process.exit(0)");
      }
      const allOutput = [...consoleOutput, ...consoleError].join("\n");
      expect(allOutput).toContain("agents");
      expect(allOutput).toContain("Commands:");
      expect(allOutput).toContain("init");
      expect(allOutput).toContain("dev");
      expect(allOutput).toContain("deploy");
      expect(allOutput).toContain("mcp");
    });

    it("should require a command", async () => {
      const cli = createCli(["node", "cli.js"]);
      try {
        await cli.parse();
        // Should have exited with error
        expect(exitCode).toBe(1);
      } catch (error: unknown) {
        // yargs calls process.exit(1) which throws
        expect((error as Error).message).toBe("process.exit(1)");
        expect(exitCode).toBe(1);
      }
      const allOutput = [...consoleOutput, ...consoleError].join("\n");
      expect(allOutput).toContain("Please provide a command");
    });

    it("should reject unknown commands", async () => {
      const cli = createCli(["node", "cli.js", "unknown"]);
      try {
        await cli.parse();
        // Should have exited with error
        expect(exitCode).toBe(1);
      } catch (error: unknown) {
        // yargs calls process.exit(1) which throws
        expect((error as Error).message).toBe("process.exit(1)");
        expect(exitCode).toBe(1);
      }
      const allOutput = [...consoleOutput, ...consoleError].join("\n");
      expect(allOutput).toMatch(/unknown/i);
    });
  });
});
