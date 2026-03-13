import { DurableObject } from "cloudflare:workers";
import { Shell } from "../src/Shell";
import { DOSqlExecutor, DynamicIsolateExecutor } from "../src/workers";
import type { WorkerLoaderLike } from "../src/workers";

// ── Env type ────────────────────────────────────────────────────────

export interface Env {
  SHELL_DO: DurableObjectNamespace<ShellDO>;
  LOADER: WorkerLoaderLike;
}

// ── Durable Object ──────────────────────────────────────────────────

export class ShellDO extends DurableObject<Env> {
  private getSqlExecutor(): DOSqlExecutor {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new DOSqlExecutor(this.ctx.storage.sql as any);
  }

  private getCodeExecutor(): DynamicIsolateExecutor {
    return new DynamicIsolateExecutor({ loader: this.env.LOADER });
  }

  /** Execute a shell command with sql + code executor wired up */
  async exec(
    cmd: string,
    options?: {
      files?: Record<string, string>;
      env?: Record<string, string>;
      cwd?: string;
    }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const sql = this.getSqlExecutor();
    const executor = this.getCodeExecutor();
    const shell = new Shell({
      sql,
      executor,
      files: options?.files,
      env: options?.env,
      cwd: options?.cwd
    });
    const r = await shell.exec(cmd);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
  }

  /** Execute multiple commands in sequence on the same shell instance */
  async execMany(
    commands: string[],
    options?: {
      files?: Record<string, string>;
      env?: Record<string, string>;
      cwd?: string;
    }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }[]> {
    const sql = this.getSqlExecutor();
    const executor = this.getCodeExecutor();
    const shell = new Shell({
      sql,
      executor,
      files: options?.files,
      env: options?.env,
      cwd: options?.cwd
    });
    const results = [];
    for (const cmd of commands) {
      const r = await shell.exec(cmd);
      results.push({
        stdout: r.stdout,
        stderr: r.stderr,
        exitCode: r.exitCode
      });
    }
    return results;
  }

  /** Raw SQL query through DOSqlExecutor */
  async sqlQuery(
    sql: string
  ): Promise<{ columns: string[]; values: unknown[][] }> {
    return this.getSqlExecutor().query(sql);
  }

  /** Raw SQL statement through DOSqlExecutor */
  async sqlRun(sql: string): Promise<{ changes: number }> {
    return this.getSqlExecutor().run(sql);
  }
}

// ── HTTP router ─────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "POST") {
      return new Response("POST only", { status: 405 });
    }

    // Each request gets a fresh DO (unique id) for isolation,
    // unless ?room=<name> is specified for stateful tests.
    const room = url.searchParams.get("room");
    const id = room
      ? env.SHELL_DO.idFromName(room)
      : env.SHELL_DO.newUniqueId();
    const stub = env.SHELL_DO.get(id);

    const body = (await request.json()) as Record<string, unknown>;

    if (url.pathname === "/exec") {
      const result = await stub.exec(
        body.cmd as string,
        body.options as {
          files?: Record<string, string>;
          env?: Record<string, string>;
          cwd?: string;
        }
      );
      return Response.json(result);
    }

    if (url.pathname === "/exec-many") {
      const results = await stub.execMany(
        body.commands as string[],
        body.options as {
          files?: Record<string, string>;
          env?: Record<string, string>;
          cwd?: string;
        }
      );
      return Response.json(results);
    }

    if (url.pathname === "/sql/query") {
      const result = await stub.sqlQuery(body.sql as string);
      return Response.json(result);
    }

    if (url.pathname === "/sql/run") {
      const result = await stub.sqlRun(body.sql as string);
      return Response.json(result);
    }

    return new Response("Not found", { status: 404 });
  }
};
