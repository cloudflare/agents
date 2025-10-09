import type { Provider } from "./providers";
import type {
  AgentMiddleware,
  AgentState,
  ToolHandler,
  ApproveBody,
  Persisted,
  ToolCall
} from "./types";
import { Agent } from "../";
import { vfs, hitl } from "./middleware";
import { step } from "./runner";
import { type AgentEvent, AgentEventType } from "./events";

const INITIAL_STATE: AgentState = { messages: [], files: {} };
const EVENTS_RING_MAX = 500;

// Utility: collect tools from middleware
function collectTools(mw: AgentMiddleware[]): Record<string, ToolHandler> {
  const acc: Record<string, ToolHandler> = {};
  for (const m of mw) {
    if (!m.tools) continue;
    for (const [name, fn] of Object.entries(m.tools)) {
      if (acc[name]) throw new Error(`Tool ${name} already exists (conflict).`);
      acc[name] = fn;
    }
  }
  return acc;
}

/**
 * This creates a Durable Object class that needs to be exported, so wrangler can read it.
 * Make sure you add the binding `AGENT_THREAD` in your `wrangler.jsonc` file.
 */
export const createAgentThread = (options: {
  provider: Provider;
  middleware?: AgentMiddleware[];
  initialState?: AgentState;
}): typeof Agent<unknown> => {
  return class extends Agent {
    provider = options.provider;
    middleware: AgentMiddleware[] = options.middleware ?? [
      vfs(),
      hitl({ interceptTools: ["execute_sql"] })
    ]; // example defaults, needs update

    load(): Persisted {
      const data = this.ctx.storage.kv.get<Persisted>("persist");
      if (data) return data;
      const init: Persisted = {
        state: options.initialState ?? INITIAL_STATE,
        run: null,
        events: [],
        events_seq: 0
      };
      this.ctx.storage.kv.put("persist", init);
      return init;
    }

    save(persist: Persisted) {
      this.ctx.storage.kv.put("persist", persist);
    }

    emit(persist: Persisted, type: AgentEventType, data: unknown) {
      const evt = {
        type,
        data,
        thread_id: persist.thread_id || this.ctx.id.toString(),
        ts: new Date().toISOString(),
        seq: ++persist.events_seq
      } as AgentEvent;

      // ring buffer
      persist.events.push(evt);
      if (persist.events.length > EVENTS_RING_MAX) persist.events.shift();

      // broadcast to connected clients if any
      this.broadcast(JSON.stringify(evt));
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
        default:
          return new Response("not found", { status: 404 });
      }
    }

    async invoke(req: Request) {
      try {
        const body = (await req.json().catch(() => ({}))) as {
          messages?: AgentState["messages"];
          files?: Record<string, string>;
          idempotencyKey?: string;
          thread_id?: string;
        };
        const persist = this.load();

        // Store thread_id on first invoke if provided
        if (body.thread_id && !persist.thread_id) {
          persist.thread_id = body.thread_id;
        }

        // Merge input into state
        if (body.messages?.length)
          persist.state.messages.push(...body.messages);
        if (body.files)
          persist.state.files = {
            ...(persist.state.files ?? {}),
            ...body.files
          };

        // Start or continue run
        if (
          !persist.run ||
          ["completed", "canceled", "error"].includes(persist.run.status)
        ) {
          persist.run = {
            run_id: persist.run?.run_id ?? crypto.randomUUID(),
            status: "running",
            step: 0,
            next_alarm_at: null
          };
          this.emit(persist, AgentEventType.RUN_STARTED, {
            run_id: persist.run.run_id
          });
        } else if (persist.run.status === "paused") {
          // remains paused; client may be trying to push more messages—fine.
        }

        this.save(persist);
        await this.ensureScheduled(persist);
        return new Response(
          JSON.stringify({
            run_id: persist.run?.run_id,
            status: persist.run?.status
          }),
          { status: 202 }
        );
      } catch (error: unknown) {
        const err = error as Error;
        return new Response(
          JSON.stringify({ error: err.message, stack: err.stack }),
          { status: 500, headers: { "content-type": "application/json" } }
        );
      }
    }

    async approve(req: Request) {
      const body = (await req.json()) as ApproveBody;
      const persist = this.load();
      if (!persist.run) return new Response("no run", { status: 400 });

      // Apply approval to pending tool calls
      const pending = persist.state.meta?.pendingToolCalls ?? [];
      if (!pending.length)
        return new Response("no pending tool calls", { status: 400 });

      const decided = body.modified_tool_calls ?? pending;
      // Inject tool result messages as if they executed (or store decisions for next tick)
      // Simpler: stash back into meta for the scheduler to execute next tick
      persist.state.meta = {
        ...(persist.state.meta ?? {}),
        pendingToolCalls: decided as ToolCall[] // TOOD: check this cast
      };

      // Resume run
      persist.run.status = "running";
      persist.run.reason = undefined;
      this.emit(persist, AgentEventType.HITL_RESUME, {
        approved: body.approved,
        modified_tool_calls: decided
      });
      this.emit(persist, AgentEventType.RUN_RESUMED, {
        run_id: persist.run.run_id
      });

      this.save(persist);
      await this.ensureScheduled(persist);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    async cancel(_req: Request) {
      const persist = this.load();
      if (persist.run) {
        persist.run.status = "canceled";
        persist.run.reason = "user";
        this.emit(persist, AgentEventType.RUN_CANCELED, {
          run_id: persist.run.run_id
        });
        this.save(persist);
      }
      return new Response(JSON.stringify({ ok: true }));
    }

    getState(_req: Request) {
      const persist = this.load();
      return new Response(
        JSON.stringify({ state: persist.state, run: persist.run }),
        { headers: { "content-type": "application/json" } }
      );
    }

    getEvents(_req: Request) {
      const persist = this.load();
      return new Response(JSON.stringify({ events: persist.events }), {
        headers: { "content-type": "application/json" }
      });
    }

    // === Scheduler: ensure an alarm and perform ticks ===
    async ensureScheduled(persist: Persisted) {
      if (!persist.run || persist.run.status !== "running") return;
      const schedules = this.getSchedules();
      if (!schedules.length) {
        const now = new Date();
        persist.run.next_alarm_at = now.getTime();
        this.save(persist);
        await this.schedule(now, "run");
      }
    }

    async run() {
      const persist = this.load();
      if (!persist.run || persist.run.status !== "running") return;

      // One bounded tick to avoid subrequest limits:
      //   - at most 1 model call
      //   - then execute up to N tool calls (N small)
      const TOOLS_PER_TICK = 3;

      this.emit(persist, AgentEventType.RUN_TICK, {
        run_id: persist.run.run_id,
        step: persist.run.step
      });
      persist.run.step += 1;

      // Execute pending tool calls first (e.g. after HITL resume)
      const toolsMap = collectTools(this.middleware);
      const toolBatch = (persist.state.meta?.pendingToolCalls ?? []).splice(
        0,
        TOOLS_PER_TICK
      );

      for (const call of toolBatch) {
        this.emit(persist, AgentEventType.TOOL_STARTED, {
          tool_name: call.name,
          args: call.args
        });
        try {
          const out = await toolsMap[call.name]?.(call.args, {
            state: persist.state,
            env: this.env,
            fetch
          });
          // Append tool message
          persist.state.messages.push({
            role: "tool",
            content: typeof out === "string" ? out : JSON.stringify(out)
          });
          this.emit(persist, AgentEventType.TOOL_OUTPUT, {
            tool_name: call.name,
            output: out
          });
        } catch (e: unknown) {
          this.emit(persist, AgentEventType.TOOL_ERROR, {
            tool_name: call.name,
            error: String(e instanceof Error ? e.message : e)
          });
          // keep going; model can recover
        }
      }

      // If we consumed some but still have pending tool calls, pause to yield and reschedule
      if ((persist.state.meta?.pendingToolCalls?.length ?? 0) > 0) {
        await this.checkpoint(persist);
        await this.reschedule(persist);
        return;
      }

      // we wrap provider to emit events
      const observedProvider: Provider = {
        invoke: async (req, opts) => {
          this.emit(persist, AgentEventType.MODEL_STARTED, {
            model: req.model
          });
          const out = await this.provider.invoke(req, opts);
          this.emit(persist, AgentEventType.MODEL_COMPLETED, {
            usage: {
              input_tokens: out.usage?.promptTokens ?? 0,
              output_tokens: out.usage?.completionTokens ?? 0
            }
          });
          return out;
        },
        stream: async (req, onDelta) => {
          this.emit(persist, AgentEventType.MODEL_STARTED, {
            model: req.model
          });
          const out = await this.provider.stream(req, (d) => {
            this.emit(persist, AgentEventType.MODEL_DELTA, { delta: d });
            onDelta(d);
          });
          this.emit(persist, AgentEventType.MODEL_COMPLETED, {
            usage: undefined
          });
          return out;
        }
      };

      // Now do one model step
      const verdict = await step(
        observedProvider,
        this.middleware,
        persist.state
      );
      persist.state = verdict.state;

      if (verdict.kind === "paused") {
        persist.run.status = "paused";
        persist.run.reason = verdict.reason;
        this.emit(persist, AgentEventType.RUN_PAUSED, {
          run_id: persist.run.run_id,
          reason: verdict.reason
        });
        await this.checkpoint(persist);
        this.save(persist);
        return;
      }

      if (verdict.kind === "error") {
        persist.run.status = "error";
        persist.run.reason = "error";
        this.emit(persist, AgentEventType.AGENT_ERROR, {
          error: verdict.error.message,
          stack: verdict.error.stack
        });
        await this.checkpoint(persist);
        await this.save(persist);
        return;
      }

      if (verdict.kind === "done") {
        persist.run.status = "completed";
        this.emit(persist, AgentEventType.AGENT_COMPLETED, {
          result: this.lastAssistant(persist.state)
        });
        await this.checkpoint(persist);
        await this.save(persist);
        return;
      }

      const last = persist.state.messages[persist.state.messages.length - 1];
      const calls =
        last?.role === "assistant" &&
        "tool_calls" in last &&
        Array.isArray(last.tool_calls)
          ? last.tool_calls
          : [];
      if (calls.length) {
        persist.state.meta = {
          ...(persist.state.meta ?? {}),
          pendingToolCalls: calls
        };
      }

      await this.checkpoint(persist);
      await this.reschedule(persist);
    }

    lastAssistant(state: AgentState) {
      for (let i = state.messages.length - 1; i >= 0; i--) {
        if (state.messages[i].role === "assistant") return state.messages[i];
      }
      return null;
    }

    async checkpoint(persist: Persisted) {
      // simple hash & size for observability
      const stateJson = JSON.stringify(persist.state);
      const hash = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(stateJson)
      );
      const hex = [...new Uint8Array(hash)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      this.emit(persist, AgentEventType.CHECKPOINT_SAVED, {
        state_hash: hex,
        size: stateJson.length
      });
      this.save(persist);
    }

    async reschedule(persist: Persisted) {
      // Yield to respect per-event subrequest limits; schedule next tick immediately
      const now = new Date();
      persist.run!.next_alarm_at = now.getTime();
      this.save(persist);
      await this.schedule(now, "run");
    }
  };
};
