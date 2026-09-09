import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type {
  PiBuiltinToolsTestObject,
  PiExecutionEnvTestObject
} from "./worker";

function fresh(): DurableObjectStub<PiExecutionEnvTestObject> {
  return env.PI_EXECUTION_ENV_TEST.getByName(crypto.randomUUID());
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
