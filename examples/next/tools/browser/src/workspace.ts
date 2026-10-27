import type { Workspace } from "@cloudflare/computer";
import { createPiTools } from "@cloudflare/computer/tools/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";

/**
 * Tools that can run again after an eviction cut them off. Reads and
 * searches have no effect, `write` replaces the whole file, and `delete`
 * succeeds on a missing path. `edit` would fail to find text it already
 * replaced, and `exec` runs arbitrary commands, so pi hands the model an
 * interrupted result for those instead.
 */
const REPLAY_SAFE = new Set(["read", "ls", "find", "grep", "write", "delete"]);

/**
 * The Workspace tools from `@cloudflare/computer/tools/pi-ai`, as
 * pi-durable `ToolRegistration`s: `read`, `ls`, `find`, `grep`, `write`,
 * `edit`, `delete`, and `exec`, which runs shell commands on the
 * Workspace's container backend.
 *
 * `createPiTools` returns declarations and one `execute`, for a
 * hand-written loop. pi-durable runs the loop itself, so this pairs them
 * up by name (as in `examples/next/harnesses/pi`).
 */
export function createWorkspaceTools(workspace: Workspace): ToolRegistration[] {
  const { tools, execute } = createPiTools({ workspace });
  return tools.map((tool): ToolRegistration => ({
    name: tool.name,
    description: tool.description,
    // Plain JSON Schema: pi validates with TypeBox, which accepts it.
    parameters: tool.parameters,
    ...(tool.constrainedSampling
      ? { constrainedSampling: tool.constrainedSampling }
      : {}),
    replay: REPLAY_SAFE.has(tool.name) ? "safe" : "unsafe",
    // Run one round's exec calls in order: `npm install` before `npm run dev`.
    ...(tool.name === "exec" ? { executionMode: "sequential" as const } : {}),
    async execute(args, api, context) {
      const { content, isError } = await execute(
        { id: api.callId, name: tool.name, arguments: args },
        { abortSignal: context.abortSignal }
      );
      // pi-durable 1.2 and later read `output`, not `content`.
      return { output: content, isError };
    }
  }));
}
