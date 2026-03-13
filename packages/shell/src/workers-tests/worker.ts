import { DurableObject } from "cloudflare:workers";
import { DOSqlExecutor, DynamicIsolateExecutor } from "../workers";
import type { WorkerLoaderLike } from "../workers";
import { Bash } from "../Shell";

// ── Env type ────────────────────────────────────────────────────────

export interface Env {
  TEST_SHELL_DO: DurableObjectNamespace<TestShellDO>;
  LOADER: WorkerLoaderLike;
}

// ── Durable Object with real SqlStorage ─────────────────────────────

export class TestShellDO extends DurableObject<Env> {
  private getSqlExecutor(): DOSqlExecutor {
    // Cast needed: SqlStorage's generic on exec() has stricter variance
    // than DOSqlStorageLike's, but they're compatible at runtime.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new DOSqlExecutor(this.ctx.storage.sql as any);
  }

  private getCodeExecutor(): DynamicIsolateExecutor {
    return new DynamicIsolateExecutor({ loader: this.env.LOADER });
  }

  /** Run a raw SQL query through DOSqlExecutor */
  async query(
    sql: string
  ): Promise<{ columns: string[]; values: unknown[][] }> {
    return this.getSqlExecutor().query(sql);
  }

  /** Run a raw SQL statement through DOSqlExecutor */
  async run(sql: string): Promise<{ changes: number }> {
    return this.getSqlExecutor().run(sql);
  }

  /** Run a shell command with the sqlite3 command wired to real SqlStorage */
  async execShellCommand(
    cmd: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const sql = this.getSqlExecutor();
    const shell = new Bash({ sql });
    const r = await shell.exec(cmd);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
  }

  /** Run code through DynamicIsolateExecutor with Worker Loader */
  async executeCode(
    code: string,
    language: "javascript" | "python"
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const executor = this.getCodeExecutor();
    const r = await executor.execute(code, language);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
  }

  /** Run a shell command with both sql and executor wired up */
  async execCodeShellCommand(
    cmd: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const executor = this.getCodeExecutor();
    const shell = new Bash({ executor });
    const r = await shell.exec(cmd);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
  }
}

// ── Default export (required by wrangler) ───────────────────────────

export default {
  async fetch(): Promise<Response> {
    return new Response("shell workers test harness");
  }
};
