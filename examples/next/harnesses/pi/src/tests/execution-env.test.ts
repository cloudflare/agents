import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
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
