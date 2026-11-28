import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runDurableObjectAlarm } from "cloudflare:test";
import { tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { withoutFinalSemicolon } from "../extensions/codemode";
import { codemode } from "../extensions/index";
import { harnessHookRules } from "../extensions/hooks";
import { loadInProcess } from "../extensions/in-process";
import { ExtensionManager } from "../extensions/manager";
import { modelTools } from "../tools";

function fresh(name = crypto.randomUUID()) {
  return env.THINK_CODEMODE.getByName(name);
}

function text(result: { status: string; text?: string }): string | undefined {
  return result.status === "done" ? result.text : undefined;
}

describe("codemode as an extension", () => {
  it("offers the model code and the direct tools, and lists the rest by namespace", async () => {
    const stub = fresh();
    await stub.prompt("async () => 1");
    expect((await stub.lastOffered()).sort()).toEqual(["ask", "code"]);
    const system = await stub.lastSystem();
    expect(system).toContain("Functions for code");
    expect(system).toContain("declare const tools:");
    expect(system).toContain("multiply: (input: MultiplyInput)");
    expect(system).not.toContain("ask: (input");
  });

  it("runs a script whose calls go through the harness, and reports it with a header", async () => {
    const stub = fresh();
    const script = "async () => (await tools.multiply({ value: 2 })) + 1";
    const reply = text(await stub.prompt(script)) ?? "";
    expect(reply).toContain("The script returned.");
    expect(reply).toContain(script);
    expect(reply).toContain("Result: 7");
    expect(reply).toContain("Calls: tools.multiply");
  });

  it("runs a script in the sandbox object the same way", async () => {
    const stub = fresh();
    await stub.useSandbox();
    const reply =
      text(
        await stub.prompt(
          "async () => (await tools.multiply({ value: 2 })) + 1"
        )
      ) ?? "";
    expect(reply).toContain("Result: 7");
    expect(reply).toContain("Calls: tools.multiply");
  });

  it("fails a call whose input doesn't match the tool's schema", async () => {
    const stub = fresh();
    const reply =
      text(await stub.prompt("async () => await tools.multiply({})")) ?? "";
    expect(reply).toContain("The script failed");
    expect(reply).toContain('Invalid input for tool "multiply"');
  });

  it("reports a BigInt result as its digits", async () => {
    const stub = fresh();
    const reply = text(await stub.prompt("async () => 10n")) ?? "";
    expect(reply).toContain("The script returned.");
    expect(reply).toContain('Result: "10"');
  });

  it("runs an arrow function that ends with a semicolon", async () => {
    const stub = fresh();
    const reply = text(await stub.prompt("async () => 1;")) ?? "";
    expect(reply).toContain("Result: 1");
  });

  it("drops a script's final semicolon past comments, in one scan", () => {
    expect(withoutFinalSemicolon("async () => 1; /* done */")).toBe(
      "async () => 1"
    );
    expect(withoutFinalSemicolon("async () => 1; // done\n")).toBe(
      "async () => 1"
    );
    expect(withoutFinalSemicolon('async () => "http://x"')).toBe(
      'async () => "http://x"'
    );
    // A URL's `//` is no comment: the semicolon after it goes.
    expect(
      withoutFinalSemicolon(
        'async () => await tools.fetch({ url: "https://example.com" });'
      )
    ).toBe('async () => await tools.fetch({ url: "https://example.com" })');
    expect(withoutFinalSemicolon('async () => f("a//b"); // done')).toBe(
      'async () => f("a//b")'
    );
    expect(withoutFinalSemicolon("async () => 'it\\'s'; // x")).toBe(
      "async () => 'it\\'s'"
    );
    // A line comment that ends in a block comment's close.
    expect(withoutFinalSemicolon("async () => 1; // a */")).toBe(
      "async () => 1"
    );
    // A block comment that holds a line comment's start.
    expect(withoutFinalSemicolon("async () => 1; /* a // b */")).toBe(
      "async () => 1"
    );
    expect(withoutFinalSemicolon("async () => /[/;]/.test(x);")).toBe(
      "async () => /[/;]/.test(x)"
    );
    // A comment with many possible ends and no way to finish: a
    // backtracking pattern tries every end.
    const ends = "1;" + "/**/".repeat(40) + "x";
    expect(withoutFinalSemicolon(ends)).toBe(ends);
  });

  it("runs an arrow function that ends with a URL and a semicolon", async () => {
    const stub = fresh();
    const reply =
      text(await stub.prompt('async () => "https://example.com";')) ?? "";
    expect(reply).toContain("https://example.com");
  });

  it("runs an arrow function that ends with a semicolon and a comment", async () => {
    const stub = fresh();
    const reply = text(await stub.prompt("async () => 1; /* done */")) ?? "";
    expect(reply).toContain("Result: 1");
  });

  it("keeps two tools callable whose names sanitize alike", async () => {
    const stub = fresh();
    const reply =
      text(
        await stub.prompt(
          "async () => [await tools.get_file({}), await tools.get_file_2({})]"
        )
      ) ?? "";
    expect(reply).toContain('Result: ["dashed","underscored"]');
  });

  it("finds and describes functions from the script", async () => {
    const stub = fresh();
    const reply =
      text(
        await stub.prompt(
          'async () => [await codemode.search("multiply"), await codemode.describe("tools.multiply")]'
        )
      ) ?? "";
    expect(reply).toContain('"name":"tools.multiply"');
    expect(reply).toContain("MultiplyInput");
    // Lookups are not tool calls.
    expect(reply).toContain("Calls: none");
  });

  it("parks the turn for an approval inside a script, and runs it again once given", async () => {
    const stub = fresh();
    await stub.prompt(
      "async () => { const n = await tools.count({}); return [n, await tools.dangerous({})]; }"
    );
    const [part] = await stub.lastParts();
    expect(part).toMatch(/^tool-code approval-requested approval:/);
    expect(await stub.counted()).toBe(1);

    const receipt = await stub.answer({
      type: "approval",
      approvalId: part?.split(" ")[2] ?? "",
      approved: true
    });
    const reply = text(await stub.wait(receipt.operationId)) ?? "";
    expect(reply).toContain('Result: [1,"ran"]');
    // count was answered from what the parked call kept.
    expect(await stub.counted()).toBe(1);
  });

  it("runs a script a reset cut short again, answering the calls it made from their steps", async () => {
    const name = crypto.randomUUID();
    let stub = fresh(name);
    const receipt = await stub.submit(
      "async () => { const a = await tools.count({}); const b = await tools.count({}); await tools.wait_here({}); return [a, b]; }"
    );
    await stub.waitStarted(1);

    await abortAllDurableObjects();
    stub = fresh(name);
    await stub.release();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const reply = text(await stub.wait(receipt.operationId)) ?? "";
    expect(reply).toContain("Result: [1,2]");
    expect(reply).toContain("Calls: tools.count, tools.count, tools.wait_here");
    // The two counts ran once; the wait, cut short, ran again.
    expect(await stub.counted()).toBe(2);
    expect(await stub.waitRuns()).toBe(2);
  });

  it("keeps the catalog within its budget, naming what didn't fit", async () => {
    const manager = new ExtensionManager(harnessHookRules);
    manager.load(
      "workspace",
      loadInProcess("workspace", (ctx) =>
        ctx.tools.transform((tools) => {
          for (const name of ["read", "write", "list", "grep"]) {
            tools.set(name, {
              ...tool({
                description: `The ${name} tool, with a long description`,
                inputSchema: z.object({ path: z.string() }),
                execute: async () => name
              })
            });
          }
        })
      )
    );
    manager.load(
      "codemode",
      loadInProcess(
        "codemode",
        codemode({
          executor: { execute: async () => ({ result: null }) },
          maxCatalogTokens: 80
        }).extension
      )
    );
    const built = await manager.build("s");
    expect(Object.keys(modelTools(built.tools, undefined))).toEqual(["code"]);
    const catalog = JSON.stringify(built);
    expect(catalog).toContain("declare const workspace:");
    expect(catalog).toMatch(/workspace: \d more, found with codemode\.search/);
  });
});
