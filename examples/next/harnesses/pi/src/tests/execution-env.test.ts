import type { WorkspaceFsLike } from "@cloudflare/shell";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createWorkspaceExecutionEnv } from "../harness/env";
import type {
  PiBuiltinToolsTestObject,
  PiExecutionEnvTestObject
} from "./worker";

function fresh(): DurableObjectStub<PiExecutionEnvTestObject> {
  return env.PI_EXECUTION_ENV_TEST.getByName(crypto.randomUUID());
}

/**
 * `runInDurableObject`, typed for this example's objects.
 *
 * The pool constrains its instance to `DurableObject<Cloudflare.Env, {}>`,
 * which an object declared as `DurableObject<Env>` against Wrangler's
 * generated `Env` does not structurally satisfy. The stub is the right object;
 * only the constraint disagrees, so the cast stops at this helper.
 */
function inObject<R>(
  stub: DurableObjectStub<PiExecutionEnvTestObject>,
  callback: (instance: PiExecutionEnvTestObject) => Promise<R>
): Promise<R> {
  return runInDurableObject(
    stub as unknown as Parameters<typeof runInDurableObject>[0],
    (instance) => callback(instance as unknown as PiExecutionEnvTestObject)
  );
}

describe("pi ExecutionEnv over a Workspace", () => {
  it("round-trips files through the durable workspace", async () => {
    const result = await fresh().fileRoundTrip();
    expect(result).toEqual({
      write: true,
      text: "first\nsecond\n",
      lines: ["first"],
      listed: ["/notes/todo.txt"],
      info: { name: "todo.txt", kind: "file", size: 13 },
      existsBefore: true,
      existsAfter: false,
      missingCode: "not_found"
    });
  });

  it("runs a shell command and persists what it writes", async () => {
    const stub = fresh();
    const result = await stub.runShell("echo hi > a.txt && cat a.txt");
    expect(result).toMatchObject({
      ok: true,
      stdout: "hi\n",
      exitCode: 0,
      streamed: ["hi\n"]
    });
    expect(await stub.readWorkspaceFile("/a.txt")).toBe("hi\n");
  });

  it("reports a timeout as an ExecutionError", async () => {
    const result = await fresh().runShell("sleep 5 && echo done", 1);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("timeout");
  });

  it("streams the output a timed-out script produced before it died", async () => {
    // pi builds a bash tool's visible result out of onStdout/onStderr alone,
    // so a killed script's partial output has to reach them all the same.
    const result = await fresh().runShell(
      "for i in 1 2 3 4 5; do echo partial; sleep 5; done",
      1
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("timeout");
    expect(result.streamed.join("")).toContain("partial\n");
  });

  it("leaves temp files and sandbox-root content alone across a run", async () => {
    // `/tmp` and `/usr` are roots the shell materializes for itself, so they
    // never appear in the sync pass's final directory set. Deleting them for
    // that reason would take the workspace's own content with them.
    const result = await inObject(fresh(), async (instance) => {
      const context = BACKGROUND_CONTEXT;
      const temp = await instance.executionEnv.createTempFile(
        { suffix: ".txt" },
        context
      );
      if (!temp.ok) throw temp.error;
      await instance.executionEnv.writeFile(temp.value, "keep me", context);
      await instance.executionEnv.writeFile(
        "/usr/notes.txt",
        "pre-existing",
        context
      );

      const exec = await instance.executionEnv.exec(
        "echo hi",
        undefined,
        context
      );

      return {
        ok: exec.ok,
        temp: await instance.workspace.readFile(temp.value),
        notes: await instance.workspace.readFile("/usr/notes.txt")
      };
    });

    expect(result).toEqual({
      ok: true,
      temp: "keep me",
      notes: "pre-existing"
    });
  });
});

describe("a workspace that cannot take the shell's writes", () => {
  it("fails the exec, naming the paths that did not persist", async () => {
    const result = await inObject(fresh(), async (instance) => {
      // One path the workspace refuses; everything else writes normally.
      const workspace = Object.create(
        instance.workspace
      ) as unknown as WorkspaceFsLike;
      Object.assign(workspace, {
        writeFileBytes: (path: string, bytes: Uint8Array) => {
          if (path === "/blocked.txt") {
            return Promise.reject(new Error("workspace is read-only"));
          }
          return instance.workspace.writeFileBytes(path, bytes);
        }
      });
      const env = createWorkspaceExecutionEnv({ workspace });

      const streamed: string[] = [];
      const exec = await env.exec(
        "echo hi > /blocked.txt && echo fine > /kept.txt && echo done",
        { onStdout: (chunk: string) => streamed.push(chunk) },
        BACKGROUND_CONTEXT
      );

      return {
        ok: exec.ok,
        code: exec.ok ? null : exec.error.code,
        message: exec.ok ? null : exec.error.message,
        streamed: streamed.join(""),
        // The writes that could land still did.
        kept: await instance.workspace.readFile("/kept.txt")
      };
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("unknown");
    expect(result.message).toContain("/blocked.txt");
    expect(result.message).toContain("workspace is read-only");
    expect(result.message).not.toContain("/kept.txt");
    // Output the script produced is still delivered before the failure.
    expect(result.streamed).toBe("done\n");
    expect(result.kept).toBe("fine\n");
  });
});

describe("a workspace too large to snapshot", () => {
  it("refuses to run rather than truncating the shell's view", async () => {
    const result = await inObject(fresh(), async (instance) => {
      await instance.workspace.writeFile("/a.txt", "a".repeat(80));
      await instance.workspace.writeFile("/b.txt", "b".repeat(80));
      const env = createWorkspaceExecutionEnv({
        workspace: instance.workspace,
        maxSnapshotTotalBytes: 100
      });

      const exec = await env.exec(
        "cat /a.txt /b.txt",
        undefined,
        BACKGROUND_CONTEXT
      );
      return {
        ok: exec.ok,
        code: exec.ok ? null : exec.error.code,
        message: exec.ok ? null : exec.error.message
      };
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("spawn_error");
    expect(result.message).toContain("maxSnapshotTotalBytes");
    expect(result.message).toContain("100");
  });

  it("refuses to run when one file is over the per-file limit", async () => {
    // The file was protected from the sync passes but invisible to the
    // shell, so `cat` reported an empty file and `grep` found nothing in a
    // file that is full of matches. Refusing is the only honest answer.
    const result = await inObject(fresh(), async (instance) => {
      await instance.workspace.writeFile("/small.txt", "ok");
      await instance.workspace.writeFile("/huge.txt", "h".repeat(200));
      const env = createWorkspaceExecutionEnv({
        workspace: instance.workspace,
        maxSnapshotFileBytes: 100
      });
      const exec = await env.exec(
        "cat /huge.txt",
        undefined,
        BACKGROUND_CONTEXT
      );
      return {
        ok: exec.ok,
        code: exec.ok ? null : exec.error.code,
        message: exec.ok ? null : exec.error.message
      };
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("spawn_error");
    expect(result.message).toContain("/huge.txt");
    expect(result.message).toContain("maxSnapshotFileBytes");
    expect(result.message).toContain("100");
  });

  it("refuses to run when the workspace holds more files than the limit", async () => {
    const result = await inObject(fresh(), async (instance) => {
      await instance.workspace.writeFile("/a.txt", "a");
      await instance.workspace.writeFile("/b.txt", "b");
      await instance.workspace.writeFile("/c.txt", "c");
      const env = createWorkspaceExecutionEnv({
        workspace: instance.workspace,
        maxSnapshotFiles: 2
      });
      const exec = await env.exec("ls /", undefined, BACKGROUND_CONTEXT);
      return {
        ok: exec.ok,
        code: exec.ok ? null : exec.error.code,
        message: exec.ok ? null : exec.error.message
      };
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("spawn_error");
    expect(result.message).toContain("maxSnapshotFiles");
    expect(result.message).toContain("2");
  });

  it("runs when the workspace fits inside the limit", async () => {
    const result = await inObject(fresh(), async (instance) => {
      await instance.workspace.writeFile("/a.txt", "a".repeat(80));
      const env = createWorkspaceExecutionEnv({
        workspace: instance.workspace,
        maxSnapshotTotalBytes: 100
      });
      const exec = await env.exec("cat /a.txt", undefined, BACKGROUND_CONTEXT);
      return { ok: exec.ok, stdout: exec.ok ? exec.value.stdout : null };
    });

    expect(result).toEqual({ ok: true, stdout: "a".repeat(80) });
  });
});

describe("pi's built-in tools over the execution environment", () => {
  it("writes through bash and reads back through read", async () => {
    const stub: DurableObjectStub<PiBuiltinToolsTestObject> =
      env.PI_BUILTIN_TOOLS_TEST.getByName(crypto.randomUUID());
    const result = await stub.runBuiltinTools();
    expect(result.writeStatus).toBe("completed");
    expect(result.readStatus).toBe("completed");
    expect(result.file).toBe("hi\n");
    expect(result.readOutput).toContain("hi");
  });
});
