/**
 * Think as an orchestrator over containerized coding agents.
 *
 * The user chats with a `CodingOrchestrator` (a Think agent). It does not edit
 * code itself — instead it delegates concrete tasks to `ClaudeCodeAgent`
 * sub-agents. Each sub-agent runs as a facet whose `this.name` is the agent-tool
 * run id, so each delegated task gets its OWN sandbox container with the repo
 * checked out. The sub-agent's stream + progress forward to the orchestrator's
 * UI, and it returns the diff it produced.
 *
 *   CodingOrchestrator (Think)  ── delegate_coding_task / delegate_parallel ──▶
 *     ClaudeCodeAgent (AIChatAgent facet, name = runId)
 *       └─ getSandbox(env.Sandbox, sandboxIdFor(this.name))  ──▶  one per task
 */

import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { getSandbox, Sandbox as BaseSandbox } from "@cloudflare/sandbox";
import { Think, type TurnConfig } from "@cloudflare/think";
import { callable, routeAgentRequest } from "agents";
import { agentTool } from "agents/agent-tools";
import { tool, type ToolSet, type UIMessage } from "ai";
import { z } from "zod";
import { runClaudeCode } from "./claude-code";
import { snapshotDiff, type WorkspaceDiff } from "./diff";

// The SDK's ContainerProxy must be exported from the Worker entry so the
// container runtime can build outbound-interception fetchers
// (`ctx.exports.ContainerProxy`). See the Sandbox subclass below.
export { ContainerProxy } from "@cloudflare/sandbox";

const REPO_URL = "https://github.com/threepointone/aywson";
const WORK_DIR = "/workspace/aywson";

type DelegateInput = { task: string };

/**
 * Forward the container's Anthropic egress through the AI Gateway binding.
 *
 * `env.AI.gateway()` is authenticated by the Worker's own account, so the
 * container needs NO Anthropic key and NO AI Gateway token — only the gateway
 * id (a plaintext var). Provider billing is handled by the gateway itself
 * (Unified Billing, or a key stored in the gateway). The intercepted request's
 * own `x-api-key` (a dummy the CLI requires) is dropped here.
 */
async function anthropicViaGateway(req: Request, env: Env): Promise<Response> {
  const endpoint = new URL(req.url).pathname.replace(/^\/+/, ""); // "v1/messages"
  const headers: Record<string, string> = {
    "content-type": "application/json"
  };
  const version = req.headers.get("anthropic-version");
  if (version) headers["anthropic-version"] = version;
  const beta = req.headers.get("anthropic-beta");
  if (beta) headers["anthropic-beta"] = beta;
  return env.AI.gateway(env.GATEWAY_ID).run({
    provider: "anthropic",
    endpoint,
    headers,
    query: await req.json()
  });
}

/**
 * The container Durable Object. We subclass the SDK's `Sandbox` to intercept
 * the container's calls to `api.anthropic.com` and route them through the AI
 * Gateway binding — no credentials ever enter the container.
 */
export class Sandbox extends BaseSandbox<Env> {
  constructor(ctx: ConstructorParameters<typeof BaseSandbox>[0], env: Env) {
    super(ctx, env);
    // Anthropic is HTTPS, so HTTPS interception is required; everything else
    // (e.g. the github.com clone) still reaches the internet normally.
    this.interceptHttps = true;
    this.enableInternet = true;
  }
}

// Register via the inherited static setter — NOT a `static` class field, which
// would shadow the accessor and never populate the interception registry.
Sandbox.outboundByHost = { "api.anthropic.com": anthropicViaGateway };

/**
 * A coding sub-agent. Thin `AIChatAgent` that delegates one task to the Claude
 * Code CLI running inside its own container, then reports back the diff.
 *
 * It never gets a top-level binding — the orchestrator spawns it as a facet via
 * `agentTool` / `runAgentTool`, so `this.name` is the run id and each task is
 * isolated in its own container.
 */
export class ClaudeCodeAgent extends AIChatAgent<Env> {
  chatRecovery = true;

  // Claude owns its native session; persist its id so each turn can --resume it.
  private sessionId: string | undefined;
  // The diff produced by the most recent turn, returned as the agent-tool output.
  private lastResult: WorkspaceDiff | undefined;

  async onStart() {
    this.sessionId = await this.ctx.storage.get<string>("claudeSessionId");
  }

  private sandbox(): Sandbox {
    // One container per sub-agent, kept warm between turns. The facet name is
    // `agent-tool:<toolCallId>`, which can exceed the 63-char DNS-safe limit a
    // sandbox id requires, so derive a short stable id from it.
    return getSandbox(this.env.Sandbox, sandboxIdFor(this.name), {
      sleepAfter: "15m"
    });
  }

  /**
   * Clone the demo repo on first use. Idempotent — cheap once it exists.
   *
   * NOTE: the container disk is ephemeral. After `sleepAfter` the container
   * cold-starts a clean filesystem, so this re-clones a pristine tree and any
   * prior uncommitted edits (and Claude's `~/.claude` session) are lost. For
   * true cross-sleep persistence, back the workspace + `~/.claude` up with
   * `sandbox.createBackup({ directory })`, store the `DirectoryBackup` handle in
   * DO storage, and restore here instead of cloning. See the README's
   * "Durability & recovery" section. Deferred to keep this example zero-config.
   */
  private async ensureWorkspace(sandbox: Sandbox): Promise<void> {
    await sandbox.exec(
      `[ -d ${WORK_DIR}/.git ] || git clone --depth 1 ${REPO_URL} ${WORK_DIR}`
    );
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const sandbox = this.sandbox();
    await this.ensureWorkspace(sandbox);

    return runClaudeCode({
      sandbox,
      workDir: WORK_DIR,
      prompt: latestUserText(this.messages),
      abortSignal: options?.abortSignal,
      loadSessionId: () => this.sessionId,
      saveSessionId: (id) => {
        this.sessionId = id;
        void this.ctx.storage.put("claudeSessionId", id);
      },
      // Forwarded to the orchestrator UI while running as an agent tool.
      reportProgress: (p) => void this.reportProgress(p),
      onResult: (result) => {
        this.lastResult = result;
      }
    });
  }

  /**
   * What the orchestrator sees when this sub-agent finishes. Keep it compact —
   * the full diff is huge and would bloat the orchestrator's context. The
   * streamed message (including the rendered diff) is what the human sees.
   */
  protected getAgentToolOutput(): unknown {
    const result = this.lastResult;
    if (!result || result.files.length === 0) {
      return "Completed with no file changes.";
    }
    return {
      filesChanged: result.files.map((f) => `${f.status || "M"} ${f.path}`),
      diffLineCount: result.diff.split("\n").length
    };
  }

  /** Live diff for this sub-agent's container (drill-in / debugging). */
  @callable()
  async getWorkspaceDiff(): Promise<WorkspaceDiff> {
    const sandbox = this.sandbox();
    await this.ensureWorkspace(sandbox);
    return snapshotDiff(sandbox, WORK_DIR);
  }
}

/**
 * The orchestrator the user chats with. A Think agent that owns the planning
 * loop and delegates the actual coding to `ClaudeCodeAgent` sub-agents.
 */
export class CodingOrchestrator extends Think<Env> {
  override chatRecovery = true;
  // Cap how many containers run at once (also bounded by container max_instances).
  override maxConcurrentAgentTools = 3;

  override getModel() {
    return "@cf/moonshotai/kimi-k2.7-code";
  }

  override getSystemPrompt(): string {
    return [
      "You are a coding orchestrator. You do NOT edit code yourself.",
      "Instead you delegate concrete, self-contained coding tasks to Claude Code",
      "agents — each runs in its own sandboxed container with the `aywson` repo",
      "(a tiny JSONC parser) checked out.",
      "Use `delegate_coding_task` for a single task.",
      "Use `delegate_parallel` to run several independent tasks at once, or to",
      "race competing attempts at the same task, then compare the diffs.",
      "Split large requests into independent tasks where it helps.",
      "Keep your own messages short: the delegated agents do the real work and",
      "their progress streams to the user live. After they finish, summarize",
      "what changed across them. If a delegate reports an error, say so honestly",
      "instead of pretending it succeeded."
    ].join(" ");
  }

  // Think ships built-in workspace tools (read/list/find/edit/…) bound to the
  // orchestrator's OWN (empty) filesystem. This orchestrator has no local repo
  // — it only delegates — so restrict the model to just the delegation tools.
  override beforeTurn(): TurnConfig {
    return { activeTools: ["delegate_coding_task", "delegate_parallel"] };
  }

  override getTools(): ToolSet {
    return {
      delegate_coding_task: agentTool<DelegateInput>(ClaudeCodeAgent, {
        description:
          "Delegate ONE self-contained coding task to a Claude Code agent " +
          "running in its own container. Streams the agent's work back and " +
          "returns the files it changed.",
        displayName: "Claude Code",
        inputSchema: z.object({
          task: z
            .string()
            .min(5)
            .describe(
              "A clear, self-contained coding task to perform in the repo."
            )
        })
      }),
      delegate_parallel: tool({
        description:
          "Delegate MULTIPLE coding tasks at once — each to its own Claude Code " +
          "container — and get every diff back to compare. Use for independent " +
          "tasks, or competing attempts at the same task.",
        inputSchema: z.object({
          tasks: z
            .array(z.string().min(5))
            .min(2)
            .max(3)
            .describe(
              "Independent coding tasks (or repeated attempts) to run in parallel."
            )
        }),
        execute: async ({ tasks }, { toolCallId, abortSignal }) => {
          const outcomes = await Promise.allSettled(
            tasks.map((task, i) =>
              this.runAgentTool<DelegateInput>(ClaudeCodeAgent, {
                input: { task },
                parentToolCallId: toolCallId,
                displayOrder: i,
                display: { name: "Claude Code" },
                signal: abortSignal
              })
            )
          );
          return outcomes.map((outcome, i) => {
            const task = tasks[i];
            if (outcome.status === "rejected") {
              return {
                task,
                error:
                  outcome.reason instanceof Error
                    ? outcome.reason.message
                    : String(outcome.reason)
              };
            }
            const run = outcome.value;
            return run.status === "completed"
              ? { task, runId: run.runId, result: run.output ?? run.summary }
              : { task, runId: run.runId, error: run.error ?? run.status };
          });
        }
      })
    };
  }

  /** Gate HTTP/WS drill-in into a sub-agent facet to runs this orchestrator owns. */
  override async onBeforeSubAgent(
    _request: Request,
    child: { className: string; name: string }
  ): Promise<Response | void> {
    if (child.className !== "ClaudeCodeAgent") {
      return new Response(`Unknown agent tool class: ${child.className}`, {
        status: 404
      });
    }
    if (!this.hasAgentToolRun(child.className, child.name)) {
      return new Response(
        `Agent tool ${child.className}/${child.name} not found`,
        { status: 404 }
      );
    }
  }

  @callable()
  async clearDelegatedRuns(): Promise<void> {
    await this.clearAgentToolRuns();
  }
}

/**
 * A stable, DNS-safe sandbox id (≤63 chars, lowercase) derived from a facet
 * name. Same name → same id → same warm container across turns.
 */
function sandboxIdFor(name: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xc2b2ae35;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
  }
  const hash = ((h1 >>> 0).toString(36) + (h2 >>> 0).toString(36)).slice(0, 16);
  return `task-${hash}`;
}

function latestUserText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return messages[i].parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("");
    }
  }
  return "";
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
