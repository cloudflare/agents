import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMemoryKeyValueStore } from "../../adapters/memory/store.js";
import { createTestClock } from "../../adapters/memory/clock.js";
import { createEventBus } from "../../kernel/events.js";
import { stableHash, type IdSource } from "../../kernel/ids.js";
import { ValidationError } from "../../kernel/errors.js";
import type { AssembledTools } from "../tools/registry.js";
import type { ToolExecutionContext, ToolSet } from "../tools/types.js";
import {
  action,
  actionRejectionErrorValue,
  createActionService,
  isAction,
  type ActionApprovalDescriptor,
  type ActionContext,
  type ActionServiceDeps,
} from "./actions.js";

/** Wraps a compiled ToolSet as the slice of AssembledTools maybeParkSuspension reads. */
function assembled(tools: ToolSet): AssembledTools {
  return { tools } as AssembledTools;
}

/** A promise plus externally-callable resolve/reject, for controlling interleaving. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets the pipeline's internal awaits settle before firing timers/aborts. */
async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/** Manually-fired fake timers so timeout behavior is deterministic. */
function fakeTimers() {
  let nextId = 1;
  const pending = new Map<number, () => void>();
  return {
    setTimeout(fn: () => void, _ms: number): unknown {
      const id = nextId++;
      pending.set(id, fn);
      return id;
    },
    clearTimeout(handle: unknown): void {
      pending.delete(handle as number);
    },
    fireAll(): void {
      for (const [id, fn] of [...pending]) {
        pending.delete(id);
        fn();
      }
    },
    count(): number {
      return pending.size;
    },
  };
}

function sequentialIds(): IdSource {
  let n = 0;
  return { newId: (prefix) => `${prefix}_${++n}` };
}

function harness(overrides?: Partial<ActionServiceDeps>) {
  const store = createMemoryKeyValueStore();
  const clock = createTestClock(1_000);
  const bus = createEventBus({ agent: "test", name: "agent-1" }, () => clock.now());
  const timers = fakeTimers();
  const service = createActionService({
    store,
    clock,
    ids: sequentialIds(),
    bus,
    timers,
    ...overrides,
  });
  return { store, clock, bus, timers, service };
}

function ctx(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    toolCallId: "call-1",
    requestId: "req-1",
    messages: [],
    signal: new AbortController().signal,
    ...overrides,
  };
}

const echoSchema = z.object({ text: z.string() });

describe("action()", () => {
  it("infers kind server when no approval policy is set", () => {
    const a = action({
      description: "echoes",
      inputSchema: echoSchema,
      execute: (input) => input.text,
    });
    expect(a.kind).toBe("server");
  });

  it("infers kind approval-gated when an approval policy is set", () => {
    const a = action({
      description: "gated",
      inputSchema: echoSchema,
      approval: true,
      execute: (input) => input.text,
    });
    expect(a.kind).toBe("approval-gated");
  });

  it("preserves an explicit kind", () => {
    const a = action({
      description: "durable",
      inputSchema: echoSchema,
      kind: "durable-pause",
      approval: true,
      execute: (input) => input.text,
    });
    expect(a.kind).toBe("durable-pause");
  });

  it("rejects a durable-pause action without an approval policy at definition time", () => {
    expect(() =>
      action({
        description: "never parks",
        inputSchema: echoSchema,
        kind: "durable-pause",
        execute: (input) => input.text,
      })
    ).toThrow(ValidationError);
  });

  it("isAction distinguishes actions from plain objects", () => {
    const a = action({ description: "x", inputSchema: echoSchema, execute: () => "ok" });
    expect(isAction(a)).toBe(true);
    expect(isAction({ description: "x" })).toBe(false);
    expect(isAction(null)).toBe(false);
    expect(isAction("nope")).toBe(false);
  });
});

describe("compile()", () => {
  it("compiles a server action into an executing tool with normalized output", async () => {
    const { service } = harness();
    const tools = service.compile({
      greet: action({
        description: "greets",
        inputSchema: echoSchema,
        execute: (input) => ({ greeting: `hi ${input.text}`, at: new Date(0) }),
      }),
    });

    const tool = tools.greet!;
    expect(tool.description).toBe("greets");
    const output = await tool.execute!({ text: "bob" }, ctx());
    expect(output).toEqual({ greeting: "hi bob", at: "1970-01-01T00:00:00.000Z" });
  });

  it("uses the explicit action name over the map key", () => {
    const { service } = harness();
    const tools = service.compile({
      mapKey: action({
        description: "named",
        name: "realName",
        inputSchema: echoSchema,
        execute: () => "ok",
      }),
    });
    expect(Object.keys(tools)).toEqual(["realName"]);
  });

  it("rejects non-action values", () => {
    const { service } = harness();
    expect(() =>
      service.compile({
        bogus: { description: "not an action", inputSchema: echoSchema, execute: () => "x" } as never,
      })
    ).toThrow(ValidationError);
  });

  it("returns a validation error value for invalid input instead of throwing", async () => {
    const { service } = harness();
    const tools = service.compile({
      strict: action({ description: "strict", inputSchema: echoSchema, execute: (i) => i.text }),
    });
    const output = (await tools.strict!.execute!({ text: 42 }, ctx())) as { error: { name: string } };
    expect(output.error.name).toBe("ActionInputValidationError");
  });

  it("converts a thrown execute into an error value (turn never crashes)", async () => {
    const { service } = harness();
    const tools = service.compile({
      boom: action({
        description: "throws",
        inputSchema: echoSchema,
        execute: () => {
          throw new Error("kapow");
        },
      }),
    });
    const output = (await tools.boom!.execute!({ text: "x" }, ctx())) as { error: { name: string; message: string } };
    expect(output.error).toEqual({ name: "Error", message: "kapow" });
  });

  it("truncates huge outputs for the model", async () => {
    const { service } = harness();
    const tools = service.compile({
      huge: action({
        description: "huge",
        inputSchema: echoSchema,
        execute: () => "x".repeat(50_000),
      }),
    });
    const output = (await tools.huge!.execute!({ text: "x" }, ctx())) as string;
    expect(typeof output).toBe("string");
    expect(output.length).toBeLessThan(20_000);
    expect(output).toContain("…[truncated");
  });
});

describe("ledger / idempotency", () => {
  it("replays a settled row: stored output returned, execute not re-called", async () => {
    const { service } = harness();
    const execute = vi.fn((input: { text: string }) => `ran:${input.text}`);
    const tools = service.compile({
      doit: action({ description: "d", inputSchema: echoSchema, idempotencyKey: "k1", execute }),
    });

    const first = await tools.doit!.execute!({ text: "a" }, ctx({ toolCallId: "call-1" }));
    const second = await tools.doit!.execute!({ text: "a" }, ctx({ toolCallId: "call-2" }));

    expect(first).toBe("ran:a");
    expect(second).toBe("ran:a");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("same key with different input is still a replay (the key is the identity)", async () => {
    const { service } = harness();
    const execute = vi.fn((input: { text: string }) => `ran:${input.text}`);
    const tools = service.compile({
      doit: action({ description: "d", inputSchema: echoSchema, idempotencyKey: "k1", execute }),
    });

    await tools.doit!.execute!({ text: "a" }, ctx({ toolCallId: "call-1" }));
    const second = await tools.doit!.execute!({ text: "DIFFERENT" }, ctx({ toolCallId: "call-2" }));

    expect(second).toBe("ran:a");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("derives the key from the idempotencyKey function over the input", async () => {
    const { service } = harness();
    const execute = vi.fn((input: { text: string }) => `ran:${input.text}`);
    const tools = service.compile({
      doit: action({
        description: "d",
        inputSchema: echoSchema,
        idempotencyKey: ({ input }) => `key-${input.text}`,
        execute,
      }),
    });

    await tools.doit!.execute!({ text: "a" }, ctx({ toolCallId: "call-1" }));
    await tools.doit!.execute!({ text: "a" }, ctx({ toolCallId: "call-2" }));
    await tools.doit!.execute!({ text: "b" }, ctx({ toolCallId: "call-3" }));

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("returns ActionPendingError for a concurrent call without an explicit key", async () => {
    const { service } = harness();
    const gate = deferred<string>();
    const tools = service.compile({
      slow: action({ description: "slow", inputSchema: echoSchema, execute: () => gate.promise }),
    });

    const firstPromise = tools.slow!.execute!({ text: "x" }, ctx({ toolCallId: "call-1" }));
    // Same toolCallId → same fallback ledger key → still pending.
    const second = (await tools.slow!.execute!({ text: "x" }, ctx({ toolCallId: "call-1" }))) as {
      error: { name: string };
    };
    expect(second.error.name).toBe("ActionPendingError");

    gate.resolve("done");
    expect(await firstPromise).toBe("done");
  });

  it("reclaims a stale pending row when the key is explicit and the lease expired", async () => {
    const { store, clock, service } = harness();
    store.put("action:ledger:doit:k1", {
      status: "pending",
      inputHash: stableHash({ text: "a" }),
      createdAt: clock.now(),
    });
    const execute = vi.fn(() => "recovered");
    const tools = service.compile({
      doit: action({ description: "d", inputSchema: echoSchema, idempotencyKey: "k1", execute }),
    });

    // Not stale yet → pending error.
    const early = (await tools.doit!.execute!({ text: "a" }, ctx())) as { error: { name: string } };
    expect(early.error.name).toBe("ActionPendingError");
    expect(execute).not.toHaveBeenCalled();

    clock.advance(300_000);
    const output = await tools.doit!.execute!({ text: "a" }, ctx());
    expect(output).toBe("recovered");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("never reclaims when pendingRetryLeaseMs is false", async () => {
    const { store, clock, service } = harness({ pendingRetryLeaseMs: false });
    store.put("action:ledger:doit:k1", {
      status: "pending",
      inputHash: stableHash({ text: "a" }),
      createdAt: clock.now(),
    });
    const execute = vi.fn(() => "never");
    const tools = service.compile({
      doit: action({ description: "d", inputSchema: echoSchema, idempotencyKey: "k1", execute }),
    });

    clock.advance(10_000_000);
    const output = (await tools.doit!.execute!({ text: "a" }, ctx())) as { error: { name: string } };
    expect(output.error.name).toBe("ActionPendingError");
    expect(execute).not.toHaveBeenCalled();
  });

  it("deletes the row on throw so a subsequent call re-runs", async () => {
    const { service } = harness();
    let calls = 0;
    const tools = service.compile({
      flaky: action({
        description: "flaky",
        inputSchema: echoSchema,
        idempotencyKey: "k1",
        execute: () => {
          calls++;
          if (calls === 1) throw new Error("first fails");
          return "second succeeds";
        },
      }),
    });

    const first = (await tools.flaky!.execute!({ text: "x" }, ctx({ toolCallId: "call-1" }))) as {
      error: { message: string };
    };
    expect(first.error.message).toBe("first fails");

    const second = await tools.flaky!.execute!({ text: "x" }, ctx({ toolCallId: "call-2" }));
    expect(second).toBe("second succeeds");
    expect(calls).toBe(2);
  });
});

describe("timeout", () => {
  it("returns a TimeoutError value, aborts the signal, and deletes the row for a clean retry", async () => {
    const { service, timers } = harness();
    let capturedSignal: AbortSignal | undefined;
    let calls = 0;
    const tools = service.compile({
      hang: action({
        description: "hangs",
        inputSchema: echoSchema,
        idempotencyKey: "k1",
        timeoutMs: 5_000,
        execute: (_input, actionCtx: ActionContext) => {
          calls++;
          if (calls === 1) {
            capturedSignal = actionCtx.signal;
            return new Promise<string>(() => {}); // never settles
          }
          return "retried ok";
        },
      }),
    });

    const resultPromise = tools.hang!.execute!({ text: "x" }, ctx({ toolCallId: "call-1" }));
    await flushMicrotasks();
    timers.fireAll();
    const result = (await resultPromise) as { error: { name: string } };

    expect(result.error.name).toBe("TimeoutError");
    expect(capturedSignal?.aborted).toBe(true);

    // Row was deleted → a retry actually re-runs.
    const second = await tools.hang!.execute!({ text: "x" }, ctx({ toolCallId: "call-2" }));
    expect(second).toBe("retried ok");
  });

  it("clears the timeout timer on success", async () => {
    const { service, timers } = harness();
    const tools = service.compile({
      quick: action({ description: "quick", inputSchema: echoSchema, execute: (i) => i.text }),
    });
    await tools.quick!.execute!({ text: "fast" }, ctx());
    expect(timers.count()).toBe(0);
  });

  it("aborts the action signal when the turn signal aborts", async () => {
    const { service } = harness();
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const gate = deferred<string>();
    const tools = service.compile({
      watch: action({
        description: "watches",
        inputSchema: echoSchema,
        execute: (_input, actionCtx: ActionContext) => {
          capturedSignal = actionCtx.signal;
          return gate.promise;
        },
      }),
    });

    const resultPromise = tools.watch!.execute!({ text: "x" }, ctx({ signal: controller.signal }));
    await flushMicrotasks();
    controller.abort(new Error("turn cancelled"));
    expect(capturedSignal?.aborted).toBe(true);
    gate.resolve("late");
    await resultPromise;
  });
});

describe("authorization", () => {
  it("defaults to a full grant: actions with permissions run", async () => {
    const { service } = harness();
    const tools = service.compile({
      send: action({
        description: "send",
        inputSchema: echoSchema,
        permissions: ["email:send"],
        execute: () => "sent",
      }),
    });
    expect(await tools.send!.execute!({ text: "x" }, ctx())).toBe("sent");
  });

  it("a narrowed grant denies missing permissions with the permissions in the error", async () => {
    const { service } = harness({
      authorizeTurn: () => ({ allowed: true, grantedPermissions: ["email:send"] }),
    });
    const execute = vi.fn(() => "wrote");
    const tools = service.compile({
      send: action({ description: "s", inputSchema: echoSchema, permissions: ["email:send"], execute: () => "sent" }),
      write: action({ description: "w", inputSchema: echoSchema, permissions: ["files:write"], execute }),
    });

    expect(await tools.send!.execute!({ text: "x" }, ctx())).toBe("sent");
    const denied = (await tools.write!.execute!({ text: "x" }, ctx())) as {
      error: { name: string; permissions: string[] };
    };
    expect(denied.error.name).toBe("ActionAuthorizationError");
    expect(denied.error.permissions).toEqual(["files:write"]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("a denied turn denies every action", async () => {
    const { service } = harness({ authorizeTurn: () => false });
    const tools = service.compile({
      any: action({ description: "a", inputSchema: echoSchema, execute: () => "ran" }),
    });
    const denied = (await tools.any!.execute!({ text: "x" }, ctx())) as { error: { name: string } };
    expect(denied.error.name).toBe("ActionAuthorizationError");
  });

  it("resolves permission functions against the input", async () => {
    const { service } = harness({
      authorizeTurn: () => ({ allowed: true, grantedPermissions: ["scope:a"] }),
    });
    const tools = service.compile({
      dyn: action({
        description: "d",
        inputSchema: echoSchema,
        permissions: ({ input }) => [`scope:${input.text}`],
        execute: () => "ran",
      }),
    });
    expect(await tools.dyn!.execute!({ text: "a" }, ctx())).toBe("ran");
    const denied = (await tools.dyn!.execute!({ text: "b" }, ctx({ toolCallId: "call-2" }))) as {
      error: { name: string };
    };
    expect(denied.error.name).toBe("ActionAuthorizationError");
  });

  it("an authorizeAction override wins over the default subset rule", async () => {
    const denyAll = harness({ authorizeAction: () => ({ allowed: false, reason: "nope" }) });
    const denyTools = denyAll.service.compile({
      a: action({ description: "a", inputSchema: echoSchema, execute: () => "ran" }),
    });
    const denied = (await denyTools.a!.execute!({ text: "x" }, ctx())) as {
      error: { name: string; message: string };
    };
    expect(denied.error.name).toBe("ActionAuthorizationError");
    expect(denied.error.message).toBe("nope");

    // Allows despite a narrowed grant that would deny by default.
    const allowAll = harness({
      authorizeTurn: () => ({ allowed: true, grantedPermissions: [] }),
      authorizeAction: () => true,
    });
    const allowTools = allowAll.service.compile({
      a: action({ description: "a", inputSchema: echoSchema, permissions: ["x"], execute: () => "ran" }),
    });
    expect(await allowTools.a!.execute!({ text: "x" }, ctx())).toBe("ran");
  });

  it("authorizeTurnOnce caches the grant per requestId until clearTurn", async () => {
    const authorizeTurn = vi.fn(() => true as const);
    const { service } = harness({ authorizeTurn });
    const tools = service.compile({
      a: action({ description: "a", inputSchema: echoSchema, execute: () => "ran" }),
    });

    await service.authorizeTurnOnce({ requestId: "req-1", trigger: "chat" });
    await tools.a!.execute!({ text: "1" }, ctx({ toolCallId: "call-1" }));
    await tools.a!.execute!({ text: "2" }, ctx({ toolCallId: "call-2" }));
    expect(authorizeTurn).toHaveBeenCalledTimes(1);

    await tools.a!.execute!({ text: "3" }, ctx({ requestId: "req-2" }));
    expect(authorizeTurn).toHaveBeenCalledTimes(2);

    service.clearTurn("req-1");
    await tools.a!.execute!({ text: "4" }, ctx({ toolCallId: "call-4" }));
    expect(authorizeTurn).toHaveBeenCalledTimes(3);
  });
});

describe("approval-gated compilation", () => {
  it("evaluates the approval predicate per input via needsApproval", async () => {
    const { service } = harness();
    const amountSchema = z.object({ amount: z.number() });
    const tools = service.compile({
      pay: action({
        description: "pays",
        inputSchema: amountSchema,
        approval: ({ input }) => input.amount > 100,
        execute: (i) => `paid ${i.amount}`,
      }),
    });

    const needsApproval = tools.pay!.needsApproval as (input: unknown) => Promise<boolean> | boolean;
    expect(typeof needsApproval).toBe("function");
    expect(await needsApproval({ amount: 50 })).toBe(false);
    expect(await needsApproval({ amount: 500 })).toBe(true);
  });

  it("passes a boolean approval policy through and leaves server actions ungated", () => {
    const { service } = harness();
    const tools = service.compile({
      gated: action({ description: "g", inputSchema: echoSchema, approval: true, execute: () => "x" }),
      open: action({ description: "o", inputSchema: echoSchema, execute: () => "x" }),
    });
    expect(tools.gated!.needsApproval).toBe(true);
    expect(tools.open!.needsApproval).toBeUndefined();
  });

  it("carries approval metadata for the turn layer", () => {
    const { service } = harness();
    const tools = service.compile({
      gated: action({
        description: "sends an email",
        inputSchema: echoSchema,
        approval: true,
        approvalRisk: "high",
        execute: () => "x",
      }),
    });
    const metadata = tools.gated!.metadata!;
    expect(metadata.action).toBe("gated");
    expect(metadata.kind).toBe("approval-gated");
    expect(metadata.approvalSummary).toBe("sends an email"); // defaults to description
    expect(metadata.approvalRisk).toBe("high");
  });

  it("actionRejectionErrorValue produces the rejection error value", () => {
    expect(actionRejectionErrorValue("pay")).toEqual({
      error: { name: "ActionRejectedError", message: 'Action "pay" was rejected' },
    });
    expect(actionRejectionErrorValue("pay", "too risky").error.message).toBe("too risky");
  });
});

describe("durable-pause", () => {
  function durableHarness(overrides?: Partial<ActionServiceDeps>) {
    const onResolved = vi.fn();
    const h = harness({ onResolved, ...overrides });
    const execute = vi.fn((input: { text: string }) => `emailed:${input.text}`);
    const tools = h.service.compile({
      sendEmail: action({
        description: "sends email",
        inputSchema: echoSchema,
        kind: "durable-pause",
        approval: true,
        execute,
      }),
    });
    const descriptor: ActionApprovalDescriptor = {
      requestId: "req-1",
      toolCallId: "call-9",
      action: "sendEmail",
      summary: "sends email",
      input: { text: "hello" },
      permissions: [],
      risk: "high",
      kind: "durable-pause",
    };
    return { ...h, onResolved, execute, tools, descriptor };
  }

  it("compiles with needsApproval always true and durablePause metadata", () => {
    const { tools } = durableHarness();
    expect(tools.sendEmail!.needsApproval).toBe(true);
    expect(tools.sendEmail!.metadata!.durablePause).toBe(true);
    expect(tools.sendEmail!.metadata!.kind).toBe("durable-pause");
  });

  it("park() persists the execution and pendingApprovals lists it", () => {
    const { service, descriptor } = durableHarness();
    const executionId = service.park(descriptor);

    const pending = service.pendingApprovals();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.executionId).toBe(executionId);
    expect(pending[0]!.status).toBe("parked");
    expect(pending[0]!.input).toEqual({ text: "hello" });
    expect(pending[0]!.descriptor.action).toBe("sendEmail");

    expect(service.pendingApprovals(executionId)).toHaveLength(1);
    expect(service.pendingApprovals("exec_other")).toHaveLength(0);
  });

  it("parked executions survive a restart over the same store", () => {
    const { store, clock, bus, service, descriptor } = durableHarness();
    const executionId = service.park(descriptor);

    const revived = createActionService({ store, clock, ids: sequentialIds(), bus });
    expect(revived.pendingApprovals(executionId)).toHaveLength(1);
  });

  it("approveExecution runs execute once, fires onResolved, and is idempotent", async () => {
    const { service, descriptor, execute, onResolved } = durableHarness();
    const executionId = service.park(descriptor);

    const output = await service.approveExecution(executionId);
    expect(output).toBe("emailed:hello");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledWith(executionId, {
      toolCallId: "call-9",
      requestId: "req-1",
      output: "emailed:hello",
    });
    expect(service.pendingApprovals()).toHaveLength(0);

    // Second approve: no re-run, no second onResolved, same result.
    const again = await service.approveExecution(executionId);
    expect(again).toBe("emailed:hello");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it("rejectExecution settles without executing and fires onResolved with the rejection", async () => {
    const { service, descriptor, execute, onResolved } = durableHarness();
    const executionId = service.park(descriptor);

    await service.rejectExecution(executionId, "not today");
    expect(execute).not.toHaveBeenCalled();
    expect(service.pendingApprovals()).toHaveLength(0);
    expect(onResolved).toHaveBeenCalledWith(executionId, {
      toolCallId: "call-9",
      requestId: "req-1",
      rejection: { name: "ActionRejectedError", message: "not today" },
    });

    // Reject and approve are both no-ops afterwards.
    await service.rejectExecution(executionId);
    await service.approveExecution(executionId);
    expect(execute).not.toHaveBeenCalled();
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it("approveExecution throws NotFoundError for an unknown executionId", async () => {
    const { service } = durableHarness();
    await expect(service.approveExecution("exec_missing")).rejects.toThrow(/exec_missing/);
  });
});

describe("attachments", () => {
  it("records attachments on success, deep-copied on read", async () => {
    const { service } = harness();
    const tools = service.compile({
      draft: action({
        description: "d",
        inputSchema: echoSchema,
        execute: (input, actionCtx: ActionContext) => {
          actionCtx.attachReply({ type: "email_draft", body: { to: input.text } });
          return "ok";
        },
      }),
    });

    await tools.draft!.execute!({ text: "bob" }, ctx());
    const first = service.attachments("req-1");
    expect(first).toEqual([{ type: "email_draft", body: { to: "bob" } }]);

    (first[0] as { type: string }).type = "mutated";
    expect(service.attachments("req-1")[0]!.type).toBe("email_draft");
  });

  it("discards attachments when execute fails", async () => {
    const { service } = harness();
    const tools = service.compile({
      failing: action({
        description: "f",
        inputSchema: echoSchema,
        execute: (_input, actionCtx: ActionContext) => {
          actionCtx.attachReply({ type: "card" });
          throw new Error("after attach");
        },
      }),
    });

    await tools.failing!.execute!({ text: "x" }, ctx());
    expect(service.attachments("req-1")).toEqual([]);
  });

  it("caps attachments at 20 per turn", async () => {
    const { service } = harness();
    const tools = service.compile({
      spam: action({
        description: "s",
        inputSchema: echoSchema,
        execute: (_input, actionCtx: ActionContext) => {
          for (let i = 0; i < 30; i++) actionCtx.attachReply({ type: "card", i });
          return "ok";
        },
      }),
    });

    await tools.spam!.execute!({ text: "x" }, ctx());
    expect(service.attachments("req-1")).toHaveLength(20);
  });

  it("does not re-fire attachments on replay", async () => {
    const { service } = harness();
    const tools = service.compile({
      once: action({
        description: "o",
        inputSchema: echoSchema,
        idempotencyKey: "k1",
        execute: (_input, actionCtx: ActionContext) => {
          actionCtx.attachReply({ type: "card" });
          return "ok";
        },
      }),
    });

    await tools.once!.execute!({ text: "x" }, ctx({ toolCallId: "call-1" }));
    expect(service.attachments("req-1")).toHaveLength(1);

    service.clearTurn("req-1");
    await tools.once!.execute!({ text: "x" }, ctx({ toolCallId: "call-2" })); // replay
    expect(service.attachments("req-1")).toEqual([]);
  });

  it("attachReply is a no-op outside its own call (e.g. from a later callback)", async () => {
    const { service } = harness();
    let stashed: ((a: { type: string }) => void) | undefined;
    const tools = service.compile({
      stash: action({
        description: "s",
        inputSchema: echoSchema,
        execute: (_input, actionCtx: ActionContext) => {
          stashed = actionCtx.attachReply;
          return "ok";
        },
      }),
    });

    await tools.stash!.execute!({ text: "x" }, ctx());
    expect(service.attachments("req-1")).toEqual([]);

    stashed!({ type: "late" }); // fired after the call settled → ignored
    expect(service.attachments("req-1")).toEqual([]);
  });

  it("attachments() without a requestId returns attachments across turns; clearTurn drops one turn", async () => {
    const { service } = harness();
    const tools = service.compile({
      a: action({
        description: "a",
        inputSchema: echoSchema,
        execute: (input, actionCtx: ActionContext) => {
          actionCtx.attachReply({ type: input.text });
          return "ok";
        },
      }),
    });

    await tools.a!.execute!({ text: "one" }, ctx({ requestId: "req-1", toolCallId: "c1" }));
    await tools.a!.execute!({ text: "two" }, ctx({ requestId: "req-2", toolCallId: "c2" }));
    expect(service.attachments()).toHaveLength(2);

    service.clearTurn("req-1");
    expect(service.attachments()).toEqual([{ type: "two" }]);
    expect(service.attachments("req-1")).toEqual([]);
  });
});

describe("maybeParkSuspension() (audit 26 extraction 4)", () => {
  it("parks a durable-pause tool's suspension and returns its executionId", () => {
    const { service } = harness();
    const tools = service.compile({
      deploy: action({
        description: "deploys",
        inputSchema: z.object({ env: z.string() }),
        kind: "durable-pause",
        approval: true,
        permissions: ["ops:deploy"],
        approvalSummary: "Deploy to prod",
        approvalRisk: "high",
        execute: (input: { env: string }) => ({ deployed: input.env }),
      }),
    });

    const result = service.maybeParkSuspension({
      requestId: "req-1",
      pending: [{ toolCallId: "call-1", toolName: "deploy", input: { env: "prod" } }],
      tools: assembled(tools),
    });

    expect(result.parked).toBe(true);
    expect(result.executionId).toBeDefined();
    const pending = service.pendingApprovals(result.executionId);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.descriptor).toMatchObject({
      action: "deploy",
      summary: "Deploy to prod",
      permissions: ["ops:deploy"],
      risk: "high",
      kind: "durable-pause",
      requestId: "req-1",
      toolCallId: "call-1",
    });
  });

  it("is a no-op (not parked) for a plain approval-gated tool", () => {
    const { service } = harness();
    const tools = service.compile({
      dangerous: action({
        description: "risky",
        inputSchema: z.object({}),
        approval: true,
        execute: () => "ok",
      }),
    });

    const result = service.maybeParkSuspension({
      requestId: "req-1",
      pending: [{ toolCallId: "call-1", toolName: "dangerous", input: {} }],
      tools: assembled(tools),
    });

    expect(result).toEqual({ parked: false });
    expect(service.pendingApprovals()).toHaveLength(0);
  });

  it("is a no-op for a client tool (no server metadata at all)", () => {
    const { service } = harness();
    const result = service.maybeParkSuspension({
      requestId: "req-1",
      pending: [{ toolCallId: "call-1", toolName: "clientTool", input: {} }],
      tools: assembled({ clientTool: { description: "client", inputSchema: z.object({}) } }),
    });
    expect(result).toEqual({ parked: false });
  });

  it("is a no-op when there is no pending call", () => {
    const { service } = harness();
    const result = service.maybeParkSuspension({ requestId: "req-1", pending: [], tools: assembled({}) });
    expect(result).toEqual({ parked: false });
  });

  it("defaults permissions to [] and omits risk when the tool declares neither", () => {
    const { service } = harness();
    const tools = service.compile({
      pause: action({
        description: "pauses",
        inputSchema: z.object({}),
        kind: "durable-pause",
        approval: true,
        execute: () => "ok",
      }),
    });

    const result = service.maybeParkSuspension({
      requestId: "req-1",
      pending: [{ toolCallId: "call-1", toolName: "pause", input: {} }],
      tools: assembled(tools),
    });

    const pending = service.pendingApprovals(result.executionId);
    expect(pending[0]!.descriptor.permissions).toEqual([]);
    expect(pending[0]!.descriptor.risk).toBeUndefined();
  });
});
