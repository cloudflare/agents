import { WorkerEntrypoint } from "cloudflare:workers";
import { Bash } from "just-bash";

/**
 * Props passed to the BashLoopback via ctx.exports
 */
export interface BashLoopbackProps {
  sessionId: string;
}

/**
 * Result from executing a bash command
 */
export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * BashLoopback - Provides bash command execution to dynamic workers
 *
 * This WorkerEntrypoint is instantiated via ctx.exports and passed to
 * dynamic workers. When the dynamic worker calls methods on this binding,
 * it executes bash commands in an in-memory virtual filesystem.
 *
 * Usage from dynamic worker:
 *   const result = await env.BASH.exec("echo hello");
 *   console.log(result.stdout); // "hello\n"
 */
export class BashLoopback extends WorkerEntrypoint<Env, BashLoopbackProps> {
  // Static storage of Bash instances by sessionId
  // This allows the filesystem to persist across RPC calls
  private static instances: Map<string, Bash> = new Map();

  /**
   * Get or create the Bash instance for this session
   * Files persist across exec() calls within the same session
   */
  private getBash(): Bash {
    const sessionId = this.ctx.props.sessionId;
    let bash = BashLoopback.instances.get(sessionId);

    if (!bash) {
      bash = new Bash({
        // Initial files can be seeded here
        files: {
          "/home/user/README.md":
            "# Workspace\n\nThis is your coding workspace."
        },
        // Environment variables
        env: {
          SESSION_ID: sessionId
        },
        // Execution limits to prevent runaway code
        executionLimits: {
          maxCallDepth: 50,
          maxCommandCount: 5000,
          maxLoopIterations: 5000
        }
        // Network is disabled by default for security
        // To enable: network: { allowedUrlPrefixes: [...] }
      });
      BashLoopback.instances.set(sessionId, bash);
    }

    return bash;
  }

  /**
   * Execute a bash command
   *
   * @param command - The bash command to execute
   * @param options - Optional execution options
   * @returns Result with stdout, stderr, and exitCode
   */
  async exec(
    command: string,
    options?: { cwd?: string; env?: Record<string, string> }
  ): Promise<BashResult> {
    const bash = this.getBash();

    try {
      const result = await bash.exec(command, options);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode
      };
    } catch (e) {
      // Handle execution errors (e.g., limits exceeded)
      return {
        stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
        exitCode: 1
      };
    }
  }

  /**
   * Write a file to the virtual filesystem
   *
   * @param path - Absolute path to the file
   * @param content - File content
   */
  async writeFile(path: string, content: string): Promise<void> {
    const bash = this.getBash();
    // Escape single quotes for bash
    const escaped = content.replace(/'/g, "'\\''");
    await bash.exec(
      `mkdir -p "$(dirname '${path}')" && printf '%s' '${escaped}' > '${path}'`
    );
  }

  /**
   * Read a file from the virtual filesystem
   *
   * @param path - Absolute path to the file
   * @returns File content or null if not found
   */
  async readFile(path: string): Promise<string | null> {
    const bash = this.getBash();
    const result = await bash.exec(`cat "${path}" 2>/dev/null`);
    if (result.exitCode !== 0) {
      return null;
    }
    return result.stdout;
  }

  /**
   * List files in a directory
   *
   * @param path - Directory path
   * @returns Array of filenames
   */
  async listFiles(path = "/home/user"): Promise<string[]> {
    const bash = this.getBash();
    const result = await bash.exec(`ls -1 "${path}" 2>/dev/null`);
    if (result.exitCode !== 0) {
      return [];
    }
    return result.stdout.split("\n").filter(Boolean);
  }

  /**
   * Get the current working directory
   */
  async getCwd(): Promise<string> {
    const bash = this.getBash();
    const result = await bash.exec("pwd");
    return result.stdout.trim();
  }
}
