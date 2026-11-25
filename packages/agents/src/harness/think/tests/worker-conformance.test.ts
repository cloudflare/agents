import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { harnessHookRules } from "../extensions/hooks";
import { loadInProcess } from "../extensions/in-process";
import { ExtensionManager } from "../extensions/manager";
import type { ExtensionHandle } from "../extensions/types";
import { EXTENSION_WORKER_RUNTIME } from "../extensions/worker-runtime.generated";
import { modelTools } from "../tools";
import extension from "./fixtures/conformance-extension.js";
import source from "./fixtures/conformance-extension.js?raw";

/** The same extension in a dynamic Worker running the bundled runtime. */
function inWorker(): Promise<ExtensionHandle> {
  const loader = (env as unknown as { LOADER: WorkerLoader }).LOADER;
  const worker = loader.get(`conformance-${crypto.randomUUID()}`, () => ({
    compatibilityDate: "2026-06-11",
    mainModule: "runtime.js",
    modules: {
      "runtime.js": EXTENSION_WORKER_RUNTIME,
      "extension.js": source,
      "manifest.js": `export default ${JSON.stringify({ name: "ext" })};`
    },
    globalOutbound: null
  }));
  // SAFETY: the runtime's entrypoint methods are the extension handle's.
  return Promise.resolve(worker.getEntrypoint() as unknown as ExtensionHandle);
}

async function observe(handle: Promise<ExtensionHandle>) {
  const manager = new ExtensionManager(harnessHookRules);
  manager.load("ext", handle);
  const built = await manager.build("s");
  const direct = await handle;
  const call = { id: "c", session: "s", messages: [] };
  const outputs: unknown[] = [];
  return {
    tools: JSON.stringify(modelTools(built.tools, undefined)),
    recovery: (built.tools.add as { recovery?: string }).recovery,
    system: built.system,
    hooks: (await direct.describe()).hooks,
    add: await direct.execute("add", { a: 2, b: 3 }, call, () => {}),
    count: {
      outcome: await direct.execute("count", {}, call, (output) => {
        outputs.push(output);
      }),
      outputs
    },
    fail: await direct.execute("fail", {}, call, () => {}),
    approval: await direct.needsApproval("fail", {}, call),
    decisions: [
      await manager.hook("beforeToolCall", {
        session: "s",
        operationId: "op",
        toolCallId: "c",
        toolName: "add",
        input: { a: 1 },
        attempt: 1
      }),
      await manager.hook("beforeToolCall", {
        session: "s",
        operationId: "op",
        toolCallId: "c",
        toolName: "fail",
        input: {},
        attempt: 1
      })
    ],
    classes: [
      await manager.hook("classifyError", { error: new Error("overflow") }),
      await manager.hook("classifyError", { error: new Error("other") })
    ]
  };
}

describe("extensions: one file in process and in a Worker", () => {
  it("gives the same entries, outcomes and decisions", async () => {
    const inProcess = await observe(loadInProcess("ext", extension));
    const worker = await observe(inWorker());
    expect(worker).toEqual(inProcess);
    expect(inProcess).toMatchObject({
      recovery: "rerun",
      system: "Rules.",
      add: { ok: true, output: 5 },
      count: { outcome: { ok: true, output: 3 }, outputs: [1, 2, 3] },
      fail: { ok: false, errorText: "it failed" },
      approval: true,
      decisions: [
        { action: "run", input: { a: 1, checked: true } },
        { action: "block", reason: "no" }
      ],
      classes: ["context-overflow", undefined]
    });
  });
});
