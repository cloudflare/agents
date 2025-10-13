import type { Provider } from "../providers";
import type {
  AgentMiddleware,
  AgentState,
  ToolHandler,
  ApproveBody,
  ToolCall,
  InvokeBody,
  ToolMeta,
  SubagentDescriptor,
  MWContext,
  ParentInfo
} from "../types";
import { Agent, getAgentByName, type AgentContext } from "../..";
import { subagents, planning, filesystem, getToolMeta } from "../middleware";
import { type AgentEvent, AgentEventType } from "../events";
import { step } from "./step";
import { Store } from "./store";

function collectToolsAndDefs(
  mw: AgentMiddleware[],
  extra?: Record<string, ToolHandler>
): { handlers: Record<string, ToolHandler>; defs: ToolMeta[] } {
  const handlers: Record<string, ToolHandler> = {};
  const defsMap = new Map<string, ToolMeta>();

  const ingest = (name: string, fn: ToolHandler) => {
    if (handlers[name])
      throw new Error(`Tool ${name} already exists (conflict).`);
    handlers[name] = fn;
    const meta = getToolMeta(fn, name);
    if (meta && !defsMap.has(meta.name)) defsMap.set(meta.name, meta);
  };

  // First ingest extra tools
  for (const [name, fn] of Object.entries(extra ?? {})) {
    ingest(name, fn);
  }

  // Then ingest middleware tools
  for (const m of mw) {
    for (const [name, fn] of Object.entries(m.tools ?? {})) {
      ingest(name, fn);
    }
  }
  return { handlers, defs: Array.from(defsMap.values()) };
}

export interface AgentEnv {
  DEEP_AGENT: DurableObjectNamespace<DeepAgent>;
}

export abstract class DeepAgent<
  Env extends AgentEnv = AgentEnv
> extends Agent<Env> {
  abstract provider: Provider;
  abstract defaultMiddleware: AgentMiddleware[];
  abstract subagents: Map<string, SubagentDescriptor>;
  abstract extraTools: Record<string, ToolHandler>;
  initial?: AgentState;
  protected store: Store;
  observability = undefined;

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    this.store = new Store(ctx.storage.sql, ctx.storage.kv);
    this.store.init();
  }

  // Get middleware based on agent type
  get middleware(): AgentMiddleware[] {
    const subagentType = this.store.meta<string>("subagent_type");

    if (subagentType && this.subagents.has(subagentType)) {
      return this.subagents.get(subagentType)?.middleware ?? [];
    }

    return this.defaultMiddleware;
  }

  // Get tools based on agent type
  get tools(): Record<string, ToolHandler> {
    const subagentType = this.store.meta<string>("subagent_type");

    if (subagentType && this.subagents.has(subagentType)) {
      return this.subagents.get(subagentType)?.tools ?? {};
    }

    return this.extraTools;
  }

  get mwContext(): MWContext {
    return {
      agent: this,
      store: this.store,
      provider: this.provider
    };
  }

  get isPaused(): boolean {
    return this.store.runState?.status === "paused";
  }

  get isWaitingSubagents(): boolean {
    return this.isPaused && this.store.waitingSubagents.length > 0;
  }

  get isDone(): boolean {
    const last = this.lastAssistant();
    return !!last && (!("tool_calls" in last) || last.tool_calls?.length === 0);
  }

  // TODO: step 4. of GPT answer + store events somewhere else. why does emit need persist?
  emit(type: AgentEventType, data: unknown) {
    const evt = {
      type,
      data,
      thread_id: this.store.threadId || this.ctx.id.toString(),
      ts: new Date().toISOString()
    } as AgentEvent;

    const seq = this.store.addEvent(evt);

    // broadcast to connected clients if any
    this.broadcast(JSON.stringify({ ...evt, seq }));
    console.log(JSON.stringify({ ...evt, seq }, null, 2));
  }

  async onStart() {
    for (const m of this.middleware) await m.onInit?.(this.mwContext);
  }

  // callback exposed by Agent class
  async onRequest(req: Request) {
    const url = new URL(req.url);
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
      default:
        return new Response("not found", { status: 404 });
    }
  }

  async invoke(req: Request) {
    try {
      const body = (await req.json().catch(() => ({}))) as InvokeBody;

      // Store thread_id on first invoke if provided
      if (body.thread_id && !this.store.threadId) {
        this.store.setThreadId(body.thread_id);
      }

      // Merge input into state
      if (body.messages?.length) this.store.appendMessages(body.messages);
      if (body.files) this.store.mergeFiles(body.files);
      if (body.meta) this.store.mergeMeta(body.meta);

      let { runState } = this.store;
      // Start or continue run
      if (
        !runState ||
        ["completed", "canceled", "error"].includes(runState.status)
      ) {
        runState = {
          run_id: this.store.runState?.run_id ?? crypto.randomUUID(),
          status: "running",
          step: 0,
          next_alarm_at: null
        };
        this.store.upsertRun(runState);
        this.emit(AgentEventType.RUN_STARTED, {
          run_id: runState.run_id
        });
      } else if (runState.status === "paused") {
        // remains paused; client may be trying to push more messages—fine.
      }

      await this.ensureScheduled();
      const { run_id, status } = runState;
      return Response.json({ run_id, status }, { status: 202 });
    } catch (error: unknown) {
      const err = error as Error;
      return Response.json(
        { error: err.message, stack: err.stack },
        { status: 500 }
      );
    }
  }

  async approve(req: Request) {
    const body = (await req.json()) as ApproveBody;
    const { runState } = this.store;
    if (!runState) return new Response("no run", { status: 400 });

    // Apply approval to pending tool calls
    const pending = this.store.pendingToolCalls;
    if (!pending.length)
      return new Response("no pending tool calls", { status: 400 });

    const decided = body.modified_tool_calls ?? pending;
    this.store.setPendingToolCalls(decided as ToolCall[]);

    // Resume run
    runState.status = "running";
    runState.reason = undefined;
    this.emit(AgentEventType.HITL_RESUME, {
      approved: body.approved,
      modified_tool_calls: decided
    });
    this.emit(AgentEventType.RUN_RESUMED, {
      run_id: runState.run_id
    });

    this.store.upsertRun(runState);
    await this.ensureScheduled();
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }

  async cancel(_req: Request) {
    const { runState } = this.store;
    if (runState) {
      runState.status = "canceled";
      runState.reason = "user";
      this.emit(AgentEventType.RUN_CANCELED, {
        run_id: runState.run_id
      });
      this.store.upsertRun(runState);
    }
    return new Response(JSON.stringify({ ok: true }));
  }

  getState(_req: Request) {
    const { runState, threadId } = this.store;
    let state = {
      messages: this.store.listMessages(),
      events: this.store.listEvents(),
      thread_id: threadId
    };
    for (const m of this.middleware) {
      if (m.state) {
        state = { ...state, ...m.state(this.mwContext) };
      }
    }
    return Response.json({ state, run: runState });
  }

  getEvents(_req: Request) {
    return Response.json({ events: this.store.listEvents() });
  }

  // === Scheduler: ensure an alarm and perform ticks ===
  async ensureScheduled() {
    const runState = this.store.runState;
    if (!runState || runState.status !== "running") return;
    const schedules = this.getSchedules();
    if (!schedules.length) {
      // now + 1 second
      const now = new Date(Date.now() + 1000);
      runState.next_alarm_at = now.getTime();
      this.store.upsertRun(runState);
      await this.schedule(now, "run");
    }
  }

  async run() {
    const { runState } = this.store;
    if (!runState || runState.status !== "running") return;

    // One bounded tick to avoid subrequest limits:
    //   - at most 1 model call
    //   - then execute up to N tool calls (N small)
    const TOOLS_PER_TICK = 25; // we reset this after each tick anyway

    this.emit(AgentEventType.RUN_TICK, {
      run_id: runState.run_id,
      step: runState.step
    });
    runState.step += 1;
    this.store.upsertRun(runState);

    // Execute pending tool calls first (e.g. after HITL resume)
    const { handlers: toolsMap, defs: toolDefs } = collectToolsAndDefs(
      this.middleware,
      this.tools
    );
    this.store.setMeta("toolDefs", toolDefs);

    const toolBatch = this.store.popPendingToolBatch(TOOLS_PER_TICK);

    const mws = this.middleware;
    for (const call of toolBatch)
      await Promise.all(mws.map((m) => m.onToolStart?.(this.mwContext, call)));

    // Execute all tool calls in parallel
    const toolResults = await Promise.all(
      toolBatch.map(async (call) => {
        this.emit(AgentEventType.TOOL_STARTED, {
          tool_name: call.name,
          args: call.args
        });
        try {
          const out = await toolsMap[call.name]?.(call.args, {
            agent: this,
            store: this.store,
            env: this.env,
            callId: call.id
          });

          if (out === null) return { call, out };
          // Regular tool result
          this.emit(AgentEventType.TOOL_OUTPUT, {
            tool_name: call.name,
            output: out
          });
          return { call, out };
        } catch (e: unknown) {
          this.emit(AgentEventType.TOOL_ERROR, {
            tool_name: call.name,
            error: String(e instanceof Error ? e.message : e)
          });
          return { call, error: e };
        }
      })
    );

    await Promise.all(
      toolResults.map(async (r) => {
        if ("error" in r && r.error) {
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
          tool_call_id: call.id
        };
      });
    this.store.appendMessages(messages);

    // If we're still waiting for subagents, we don't proceed to model
    if (this.isWaitingSubagents) {
      return;
    }

    // If we consumed some but still have pending tool calls, pause to yield and reschedule
    if (this.store.pendingToolCalls.length > 0) {
      await this.reschedule();
      return;
    }

    try {
      await step(this.middleware, this.mwContext);
    } catch (error: unknown) {
      const runState = {
        ...this.store.runState!,
        status: "error" as const,
        reason: "error"
      };
      this.store.upsertRun(runState);
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
      this.store.upsertRun({ ...this.store.runState!, status: "completed" });
      const last = this.lastAssistant();
      this.emit(AgentEventType.AGENT_COMPLETED, { result: last });

      const parent = this.store.meta<ParentInfo>("parent");
      // If it's a subagent, report back to the parent on completion
      if (parent?.thread_id && parent?.token) {
        const parentAgent = await getAgentByName(
          this.env.DEEP_AGENT,
          parent.thread_id
        );
        await parentAgent.fetch(
          new Request("http://do/child_result", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              token: parent.token,
              child_thread_id: this.store.threadId || this.ctx.id.toString(),
              report: last && "content" in last ? last.content : ""
            })
          })
        );
      }

      return;
    }

    await this.reschedule();
  }

  lastAssistant() {
    const messages = this.store.listMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return messages[i];
    }
    return null;
  }

  async reschedule() {
    // Yield to respect per-event subrequest limits; schedule next tick immediately
    const runState = this.store.runState;
    if (!runState) return;
    const now = new Date(Date.now() + 1000);
    runState.next_alarm_at = now.getTime();
    this.store.upsertRun(runState);
    await this.schedule(now, "run");
  }

  async childResult(req: Request) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const body = (await req.json()) as {
        token: string;
        child_thread_id: string;
        report?: string;
      };
      const hit = this.store.popWaitingSubagent(
        body.token,
        body.child_thread_id
      );
      if (!hit) return new Response("unknown token", { status: 400 });

      // append tool message with the subagent's report
      const content = body.report ?? "";
      this.store.appendToolResult(hit.tool_call_id, content);

      // events
      this.emit(AgentEventType.SUBAGENT_COMPLETED, {
        child_thread_id: body.child_thread_id,
        result: content
      });

      // Only resume if ALL waiting subagents have completed
      const remainingWaits = this.store.waitingSubagents;
      const runState = this.store.runState;

      // Resume run if all waiting subagents have completed
      if (runState && remainingWaits.length === 0) {
        runState.status = "running";
        runState.reason = undefined;
        this.store.upsertRun(runState);
        this.emit(AgentEventType.RUN_RESUMED, {
          run_id: runState.run_id
        });
        await this.ensureScheduled();
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
  }
}

/**
 * This creates a Durable Object class that needs to be exported, so wrangler can read it.
 * Make sure you add the binding `DEEP_AGENT` in your `wrangler.jsonc` file.
 */
export const createDeepAgent = (options: {
  provider: Provider;
  middleware?: AgentMiddleware[];
  systemPrompt?: string;
  model?: string;
  tools?: Record<string, ToolHandler>;
  subagents?: SubagentDescriptor[];
}): typeof Agent<unknown> => {
  // Build configuration maps from subagent descriptors
  const subagentDescriptorMap = new Map<string, SubagentDescriptor>();

  for (const desc of options.subagents ?? []) {
    subagentDescriptorMap.set(desc.name, desc);
  }
  return class extends DeepAgent {
    defaultMiddleware: AgentMiddleware[] = options.middleware ?? [
      planning(),
      filesystem(),
      subagents({ subagents: options.subagents })
    ];
    subagents = subagentDescriptorMap;
    extraTools = options.tools ?? {};

    // Wrapped provider to emit events
    provider: Provider = {
      invoke: async (req, opts) => {
        this.emit(AgentEventType.MODEL_STARTED, {
          model: req.model
        });
        const out = await options.provider.invoke(req, opts);
        this.emit(AgentEventType.MODEL_COMPLETED, {
          usage: {
            input_tokens: out.usage?.promptTokens ?? 0,
            output_tokens: out.usage?.completionTokens ?? 0
          }
        });
        return out;
      },
      stream: async (req, onDelta) => {
        this.emit(AgentEventType.MODEL_STARTED, {
          model: req.model
        });
        const out = await options.provider.stream(req, (d) => {
          this.emit(AgentEventType.MODEL_DELTA, { delta: d });
          onDelta(d);
        });
        this.emit(AgentEventType.MODEL_COMPLETED, {
          usage: undefined
        });
        return out;
      }
    };

    async onStart() {
      await super.onStart();
      if (!this.store.meta<string>("systemPrompt") && options.systemPrompt) {
        this.store.setMeta("systemPrompt", options.systemPrompt);
      }
      if (!this.store.meta<string>("model") && options.model) {
        this.store.setMeta("model", options.model);
      }
    }
  };
};
