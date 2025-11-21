import { type Provider } from "../providers";
import type {
  AgentMiddleware,
  ToolHandler,
  ApproveBody,
  ToolCall,
  InvokeBody,
  MWContext,
  ThreadMetadata,
  AgentState,
  ParentInfo,
  ThreadRequestContext,
  RunState,
  AgentConfig
} from "../types";
import { Agent, getAgentByName, type AgentContext } from "../..";
import { getToolMeta } from "../middleware";
import { type AgentEvent, AgentEventType } from "../events";
import { step } from "./step";
import { Store } from "./store";
import { PersistedObject } from "./config";

export interface AgentEnv {
  SYSTEM_AGENT: DurableObjectNamespace<SystemAgent>;
  LLM_API_KEY?: string;
  LLM_API_BASE?: string;
}

// I rather name this State but the name's taken
export type Info = {
  threadId: string;
  createdAt: string;
  request: ThreadRequestContext;
  agentType: string;
  parentInfo?: ParentInfo;
  pendingToolCalls?: ToolCall[];
};

export abstract class SystemAgent<
  Env extends AgentEnv = AgentEnv
> extends Agent<Env> {
  protected _tools: Record<string, ToolHandler> = {};

  // State
  readonly info: Info;
  readonly runState: RunState;
  store: Store;
  observability = undefined;

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    const { kv, sql } = ctx.storage;
    this.store = new Store(sql, kv);
    this.store.init();
    this.info = PersistedObject<Info>(kv, { prefix: "_info" });
    this.runState = PersistedObject<RunState>(kv, {
      prefix: "_runState",
      defaults: {
        status: "registered"
      }
    });
  }

  abstract get middleware(): AgentMiddleware[];
  abstract get tools(): Record<string, ToolHandler>;
  abstract get systemPrompt(): string;
  abstract get model(): string;
  abstract get config(): AgentConfig;
  abstract get provider(): Provider;

  get messages() {
    return this.store.listMessages();
  }

  get mwContext(): MWContext {
    return {
      agent: this,
      provider: this.provider,
      registerTool: (tool: ToolHandler) => {
        const name = getToolMeta(tool)?.name;
        if (!name) throw new Error("Tool missing name: use defineTool(...)");

        this._tools[name] = tool;
      }
    };
  }

  get isPaused(): boolean {
    return this.runState.status === "paused";
  }

  get isWaitingSubagents(): boolean {
    return this.isPaused && this.store.waitingSubagents.length > 0;
  }

  get isDone(): boolean {
    const last = this.store.lastAssistant();
    return (
      !!last &&
      (!("toolCalls" in last) || last.toolCalls?.length === 0) &&
      "content" in last &&
      last.content.trim().length > 0
    );
  }

  emit(type: AgentEventType, data: unknown) {
    const evt = {
      type,
      data,
      threadId: this.info.threadId || this.ctx.id.toString(),
      ts: new Date().toISOString()
    } as AgentEvent;

    const seq = this.store.addEvent(evt);

    // broadcast to connected clients if any
    this.broadcast(JSON.stringify({ ...evt, seq }));
  }

  // callback exposed by Agent class
  async onRequest(req: Request) {
    const url = new URL(req.url);
    // TODO: Should MWs be able to define handlers?
    switch (url.pathname) {
      case "/invoke":
        return this.invoke(req);
      case "/approve":
        return this.approve(req);
      case "/cancel":
        return this.cancel(req);
      case "/state":
        return this.getState(req);
      case "/events":
        return this.getEvents(req);
      case "/child_result":
        return this.childResult(req);
      case "/register":
        if (req.method === "POST") return this.registerThread(req);
        return new Response("method not allowed", { status: 405 });
      default:
        return new Response("not found", { status: 404 });
    }
  }

  // TODO: revisit registration/init
  async registerThread(req: Request) {
    try {
      const metadata = await req.json<ThreadMetadata>().catch(() => null);
      if (!metadata || !metadata.id) {
        return new Response("invalid metadata", { status: 400 });
      }

      // persist ID
      if (!this.info.threadId) {
        this.info.threadId = metadata.id;
      }

      // persist agent configuration
      this.info.createdAt = metadata.createdAt;
      this.info.request = metadata.request;

      // Critical: Set the type so dynamic getters (tools/prompt) work
      if (metadata.agentType) {
        this.info.agentType = metadata.agentType;
      }

      // If this is a subagent, persist parent info immediately
      if (metadata.parent) {
        this.info.parentInfo = metadata.parent;
      }
      for (const m of this.middleware) await m.onInit?.(this.mwContext);

      return Response.json({ ok: true });
    } catch (error: unknown) {
      const err = error as Error;
      return new Response(err.message, { status: 500 });
    }
  }

  async invoke(req: Request) {
    try {
      const body = (await req.json().catch(() => ({}))) as InvokeBody;

      // Merge input into state
      if (body.messages?.length) this.store.appendMessages(body.messages);
      if (body.files) this.store.mergeFiles(body.files);

      let runState = this.runState;
      // Start or continue run
      if (
        !runState ||
        ["completed", "canceled", "error", "registered"].includes(
          runState.status
        )
      ) {
        runState.runId = this.runState?.runId ?? crypto.randomUUID();
        runState.status = "running";
        runState.step = this.runState?.step ?? 0;
        runState.nextAlarmAt = null;
        this.emit(AgentEventType.RUN_STARTED, {
          runId: runState.runId
        });
      } else if (runState.status === "paused") {
        // remains paused; client may be trying to push more messages—fine.
      }

      await this.ensureScheduled();
      const { runId, status } = runState;
      return Response.json({ runId, status }, { status: 202 });
    } catch (error: unknown) {
      const err = error as Error;
      return Response.json(
        { error: err.message, stack: err.stack },
        { status: 500 }
      );
    }
  }

  async approve(req: Request) {
    const body = await req.json<ApproveBody>();
    const runState = this.runState;
    if (!runState) return new Response("no run", { status: 400 });

    // Apply approval to pending tool calls
    const pending = this.info.pendingToolCalls ?? [];
    if (!pending.length)
      return new Response("no pending tool calls", { status: 400 });

    const decided = body.modifiedToolCalls ?? pending;
    this.info.pendingToolCalls = decided;

    // Resume run
    runState.status = "running";
    runState.reason = undefined;
    this.emit(AgentEventType.HITL_RESUME, {
      approved: body.approved,
      modifiedToolCalls: decided
    });
    this.emit(AgentEventType.RUN_RESUMED, {
      runId: runState.runId
    });

    const ctx = this.mwContext;
    for (const m of this.middleware) m.onResume?.(ctx, "hitl", body);

    await this.ensureScheduled();
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }

  async cancel(_req: Request) {
    const runState = this.runState;
    if (runState && runState.status !== "completed") {
      // Cancel all waiting subagents first
      const waitingSubagents = this.store.waitingSubagents;
      if (waitingSubagents.length > 0) {
        await Promise.all(
          waitingSubagents.map(async (subagent) => {
            try {
              const childAgent = await getAgentByName(
                this.env.SYSTEM_AGENT,
                subagent.childThreadId
              );
              await childAgent.fetch(
                new Request("http://do/cancel", {
                  method: "POST"
                })
              );
            } catch (error) {
              // Log error but continue canceling other subagents
              console.error(
                `Failed to cancel subagent ${subagent.childThreadId}:`,
                error
              );
            }
          })
        );
        // Clear waiting subagents from the database
        for (const subagent of waitingSubagents) {
          this.store.popWaitingSubagent(subagent.token, subagent.childThreadId);
          this.store.markSubagentCanceled(subagent.childThreadId);
        }
      }

      runState.status = "canceled";
      runState.reason = "user";
      this.emit(AgentEventType.RUN_CANCELED, {
        runId: runState.runId
      });
    }
    return new Response(JSON.stringify({ ok: true }));
  }

  getState(_req: Request) {
    const { threadId, agentType, parentInfo, request, createdAt } = this.info;
    const { model } = this;
    const tools = Object.values(this.tools).map((tool) => {
      const meta = getToolMeta(tool);
      if (!meta) throw new Error(`Tool ${tool.name} has no metadata`);
      return meta;
    });
    const subagentLinks = this.store.listSubagentLinks();
    let state: AgentState = {
      messages: this.store.listMessages(),
      threadId,
      agentType,
      model,
      tools,
      thread: {
        id: threadId,
        request,
        parent: parentInfo,
        createdAt,
        agentType
      }
    };
    if (parentInfo) {
      state = { ...state, parent: parentInfo };
    }
    if (subagentLinks.length) {
      state = { ...state, subagents: subagentLinks };
    }
    for (const m of this.middleware) {
      if (m.state) {
        state = { ...state, ...m.state(this.mwContext) };
      }
    }
    return Response.json({ state, run: this.runState });
  }

  getEvents(_req: Request) {
    return Response.json({ events: this.store.listEvents() });
  }

  // === Scheduler: ensure an alarm and perform ticks ===
  async ensureScheduled() {
    const runState = this.runState;
    if (!runState || runState.status !== "running") return;
    const schedules = this.getSchedules();
    if (!schedules.length) {
      const now = new Date();
      runState.nextAlarmAt = now.getTime();
      await this.schedule(now, "run");
    }
  }

  popPendingToolCalls(maxTools: number) {
    const calls = this.info.pendingToolCalls ?? [];
    if (calls.length <= maxTools) {
      this.info.pendingToolCalls = [];
      return calls;
    }
    const out = calls.slice(0, maxTools);
    this.info.pendingToolCalls = calls.slice(maxTools);
    return out;
  }

  async executePendingTools(maxTools: number) {
    const toolBatch = this.popPendingToolCalls(maxTools);

    const mws = this.middleware;
    for (const call of toolBatch)
      await Promise.all(mws.map((m) => m.onToolStart?.(this.mwContext, call)));

    // Execute all tool calls in parallel
    const tools = this.tools;
    const toolResults = await Promise.all(
      toolBatch.map(async (call) => {
        this.emit(AgentEventType.TOOL_STARTED, {
          toolName: call.name,
          args: call.args
        });
        try {
          if (!tools[call.name]) {
            return { call, error: new Error(`Tool ${call.name} not found`) };
          }

          const out = await tools[call.name](call.args, {
            agent: this,
            env: this.env,
            callId: call.id
          });

          if (out === null) return { call, out };
          // Regular tool result
          this.emit(AgentEventType.TOOL_OUTPUT, {
            toolName: call.name,
            output: out
          });
          return { call, out };
        } catch (e: unknown) {
          return { call, error: e };
        }
      })
    );

    await Promise.all(
      toolResults.map(async (r) => {
        if ("error" in r && r.error) {
          const { error, call } = r;
          this.emit(AgentEventType.TOOL_ERROR, {
            toolName: call.name,
            error: String(error instanceof Error ? error.message : error)
          });
          await Promise.all(
            mws.map((m) =>
              m.onToolError?.(this.mwContext, r.call, r.error as Error)
            )
          );
        } else if ("out" in r) {
          await Promise.all(
            mws.map((m) => m.onToolResult?.(this.mwContext, r.call, r.out))
          );
        }
      })
    );

    // Append tool messages for regular (non-spawn) results
    const messages = toolResults
      .filter((r) => r.out !== null || !!r.error)
      .map(({ call, out, error }) => {
        const content = error
          ? `Error: ${error instanceof Error ? error.message : String(error)}`
          : typeof out === "string"
            ? out
            : JSON.stringify(out ?? "Tool had no output");
        return {
          role: "tool" as const,
          content,
          toolCallId: call.id
        };
      });
    this.store.appendMessages(messages);
  }

  async run() {
    const runState = this.runState;
    if (!runState || runState.status !== "running") return;

    // One bounded tick to avoid subrequest limits:
    //   - at most 1 model call
    //   - then execute up to N tool calls (N small)
    const TOOLS_PER_TICK = 25;

    this.emit(AgentEventType.RUN_TICK, {
      runId: runState.runId,
      step: runState.step
    });
    runState.step += 1;

    const hasPendingTools = (this.info.pendingToolCalls ?? []).length > 0;

    // Skip calling the model if we have pending tools or waiting for subagents
    if (!hasPendingTools && !this.isWaitingSubagents) {
      try {
        await step(this.middleware, this.mwContext);
      } catch (error: unknown) {
        runState.status = "error";
        runState.reason = String(
          error instanceof Error ? error.message : error
        );
        this.emit(AgentEventType.AGENT_ERROR, {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
        return;
      }

      if (this.isPaused) return;

      // If the agent didn't call any more tools, we consider the run complete.
      // If it was a subagent, we also report back to the parent.
      if (this.isDone) {
        runState.status = "completed";
        const last = this.store.lastAssistant();
        this.emit(AgentEventType.AGENT_COMPLETED, { result: last });

        const parent = this.info.parentInfo;
        // If it's a subagent, report back to the parent on completion
        if (parent?.threadId && parent?.token) {
          const parentAgent = await getAgentByName(
            this.env.SYSTEM_AGENT,
            parent.threadId
          );
          const final = last && "content" in last ? last.content : "";
          await this.onDone({ agent: this, final });
          await parentAgent.fetch(
            new Request("http://do/child_result", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                token: parent.token,
                childThreadId: this.info.threadId || this.ctx.id.toString(),
                report: final
              })
            })
          );
        }

        return;
      }
    }

    // Execute pending tools
    await this.executePendingTools(TOOLS_PER_TICK);

    // If we're still waiting for subagents, don't proceed further
    if (this.isWaitingSubagents) {
      return;
    }

    const pending = this.info.pendingToolCalls ?? [];
    // If we consumed some but still have pending tool calls, reschedule to continue
    if (pending.length > 0) {
      await this.reschedule();
      return;
    }

    // Otherwise, reschedule for next model call
    await this.reschedule();
  }

  async reschedule() {
    // Yield to respect per-event subrequest limits; schedule next tick immediately
    const runState = this.runState;
    if (!runState) return;
    const now = new Date();
    runState.nextAlarmAt = now.getTime();
    await this.schedule(now, "run");
  }

  async childResult(req: Request) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const body = (await req.json()) as {
        token: string;
        childThreadId: string;
        report?: string;
      };
      const hit = this.store.popWaitingSubagent(body.token, body.childThreadId);
      if (!hit) return new Response("unknown token", { status: 400 });

      // append tool message with the subagent's report
      const content = body.report ?? "";
      this.store.appendToolResult(hit.toolCallId, content);
      this.store.markSubagentCompleted(body.childThreadId, content);

      // events
      this.emit(AgentEventType.SUBAGENT_COMPLETED, {
        childThreadId: body.childThreadId,
        result: content
      });

      // Only resume if ALL waiting subagents have completed
      const remainingWaits = this.store.waitingSubagents;
      const runState = this.runState;

      // Resume run if all waiting subagents have completed
      if (runState && remainingWaits.length === 0) {
        runState.status = "running";
        runState.reason = undefined;
        this.emit(AgentEventType.RUN_RESUMED, {
          runId: runState.runId
        });
        await this.ensureScheduled();
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
  }

  abstract onDone(ctx: { agent: SystemAgent; final: string }): Promise<void>;
}
