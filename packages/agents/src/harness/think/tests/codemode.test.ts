import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runDurableObjectAlarm } from "cloudflare:test";
import { tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { codemodeExtension } from "../extensions/codemode";
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
        codemodeExtension({
          executor: { execute: async () => ({ result: null }) },
          maxCatalogTokens: 80
        })
      )
    );
    const built = await manager.build("s");
    expect(Object.keys(modelTools(built.tools, undefined))).toEqual(["code"]);
    const catalog = JSON.stringify(built);
    expect(catalog).toContain("declare const workspace:");
    expect(catalog).toMatch(/workspace: \d more, found with codemode\.search/);
  });
});
