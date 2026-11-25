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
