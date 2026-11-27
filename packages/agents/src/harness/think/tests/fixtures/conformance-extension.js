// One extension, loaded in process and in a dynamic Worker by the
// conformance test. JSON Schema only: a Worker has no zod.
export default (ctx) => {
  ctx.tools.transform((tools, { session }) => {
    tools.set("add", {
      description: `Add two numbers (${session || "root"})`,
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"]
      },
      recovery: "rerun",
      execute: async ({ a, b }) => a + b
    });
    tools.set("count", {
      description: "Counts to three",
      inputSchema: { type: "object", properties: {} },
      execute: async function* () {
        yield 1;
        yield 2;
        yield 3;
      }
    });
    // Offered to code only: kept out of the model's tools.
    tools.set("double", {
      description: "Doubles a number",
      inputSchema: { type: "object", properties: { n: { type: "number" } } },
      callers: ["code"],
      execute: async ({ n }) => n * 2
    });
    // Made code-only by the draft, as codemode does another's tool.
    tools.set("negate", {
      description: "Negates a number",
      inputSchema: { type: "object", properties: { n: { type: "number" } } },
      execute: async ({ n }) => -n
    });
    tools.setCallers("negate", ["code"]);
    // Calls the others through the harness.
    tools.set("sum3", {
      description: "Adds three numbers, doubled",
      inputSchema: { type: "object", properties: {} },
      execute: async ({ a, b, c }, { invoke }) => {
        const first = await invoke("add", { a, b });
        if (!first.ok) return first.errorText;
        const sum = await invoke("add", { a: first.output, b: c });
        if (!sum.ok) return sum.errorText;
        const doubled = await invoke("double", { n: sum.output });
        return doubled.ok ? doubled.output : doubled.errorText;
      }
    });
    tools.set("fail", {
      description: "Always fails",
      inputSchema: { type: "object", properties: {} },
      needsApproval: true,
      execute: async () => {
        throw new Error("it failed");
      }
    });
  });
  ctx.prompt.transform((prompt) => prompt.set("rules", { text: "Rules." }));
  ctx.on("beforeToolCall", ({ toolName, input }) =>
    toolName === "fail"
      ? { action: "block", reason: "no" }
      : { action: "run", input: { ...input, checked: true } }
  );
  ctx.on("classifyError", ({ error }) =>
    String(error?.message ?? error).includes("overflow")
      ? "context-overflow"
      : undefined
  );
};
