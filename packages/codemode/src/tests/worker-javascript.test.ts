import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

function host() {
  return env.HOST.get(env.HOST.newUniqueId());
}

describe("WorkerJavaScriptBackend without Computer", () => {
  it("runs a module and returns its default export's result", async () => {
    const result = await host().run(
      "export default async (input) => ({ doubled: input.value * 2 });",
      { input: { value: 21 } }
    );
    expect(result).toMatchObject({
      exitCode: 0,
      result: JSON.stringify({ doubled: 42 })
    });
  });

  it("streams console output to stdout and stderr", async () => {
    const result = await host().run(`
      export default () => {
        console.log("to stdout");
        console.error("to stderr");
        return null;
      };
    `);
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "to stdout\n",
      stderr: "to stderr\n"
    });
  });

  it("reads and writes the host's files through node:fs", async () => {
    const stub = host();
    await stub.writeFile("/workspace/in.txt", "from the host");
    const result = await stub.run(`
      import { readFile, writeFile } from "node:fs/promises";
      export default async () => {
        const text = await readFile("/workspace/in.txt", "utf8");
        await writeFile("/workspace/out.txt", text.toUpperCase());
        return text;
      };
    `);
    expect(result).toMatchObject({
      exitCode: 0,
      result: JSON.stringify("from the host")
    });
    expect(await stub.readFile("/workspace/out.txt")).toBe("FROM THE HOST");
  });

  it("keeps code under its root", async () => {
    const result = await host().run(`
      import { readFile } from "node:fs/promises";
      export default () => readFile("/etc/passwd", "utf8");
    `);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("must stay under /workspace");
  });

  it("calls host modules, bundled modules and factory modules", async () => {
    const result = await host().run(`
      import { add } from "ws:math";
      import { greet } from "ws:greeter";
      import { shout } from "shout-kit";
      export default async () => ({
        sum: await add(2, 3),
        greeting: shout(await greet("Ada"))
      });
    `);
    expect(result).toMatchObject({
      exitCode: 0,
      result: JSON.stringify({ sum: 5, greeting: "HELLO, ADA!" })
    });
  });

  it("describes its modules for a model", async () => {
    const description = await host().describe();
    expect(description).toContain("`ws:greeter`: Greets people.");
    expect(description).toContain("`node:fs/promises`");
  });

  it("blocks network access by default", async () => {
    const result = await host().run(
      'export default () => fetch("https://example.com");'
    );
    expect(result.exitCode).toBe(1);
  });

  it("stops code that runs past its timeout", async () => {
    const result = await host().run(
      "export default () => new Promise(() => {});",
      { backend: "short-timeout", timeoutMs: 100 }
    );
    expect(result).toMatchObject({ exitCode: 1 });
    expect(result.stderr).toContain("timed out");
  });

  it("keeps a finished execution in SQLite", async () => {
    const stub = host();
    const first = await stub.run(
      'export default () => { console.log("kept"); return 7; };'
    );
    const replayed = await stub.replay(first.id);
    expect(replayed).toEqual({
      exitCode: 0,
      stdout: "kept\n",
      stderr: "",
      result: "7"
    });
  });
});
