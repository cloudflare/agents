import { describe, expect, it } from "vitest";
import {
  CHILD_MAILBOX_KIND,
  COMPILED_CHECKPOINT,
  COMPILED_PHASE,
  childMailboxKey,
  isCompiledCheckpoint,
  parseDefinitionName,
  readTaskTerminal,
  taskIdempotencyKey
} from "../../state-machine/machine";
import {
  compileTaskFunction,
  isTaskFunction,
  type CompiledTaskContext
} from "../../tasks/compile";
import {
  MAX_CHECKPOINT_BYTES,
  MAX_SERIALIZED_BYTES,
  serializeTaskCheckpoint
} from "../../state-machine/serialization";
import {
  StateMachineCheckpointTooLargeError,
  StateMachineSerializationError
} from "../../state-machine/errors";
import { defineAsk } from "../../state-machine/asks";
import type {
  StateMachineDefinition,
  StateMachineStep,
  StateMachineValue
} from "../../state-machine";

/**
 * The function-to-machine compiler and the two naming rules both definition
 * forms share. Everything here is pure, so it is tested directly rather than
 * through a Durable Object.
 */

/** A context stub carrying only what the compiled phase touches. */
function stubContext(input: unknown): CompiledTaskContext {
  const step = {
    attempt: 1,
    interrupted: null,
    signal: new AbortController().signal,
    do: () => Promise.reject(new Error("unused")),
    sleep: () => Promise.reject(new Error("unused")),
    sleepUntil: () => Promise.reject(new Error("unused")),
    status: () => Promise.resolve(),
    idempotencyKey: (name: string) => name,
    waitForEvent: () => Promise.reject(new Error("unused"))
  } satisfies StateMachineStep;
  return {
    ...step,
    input,
    complete: (result: StateMachineValue) =>
      // SAFETY: mirrors what `ReplayStep.complete` produces; the test reads
      // it back through the module's own `readTaskTerminal`.
      ({ kind: "complete", result }) as never
  };
}

describe("the function-to-machine compiler", () => {
  it("wraps a function definition as a single-phase machine", () => {
    const machine = compileTaskFunction(async () => "done");

    expect(Object.keys(machine.phases)).toEqual([COMPILED_PHASE]);
    expect(machine.initial).toBe(COMPILED_CHECKPOINT);
    expect(isCompiledCheckpoint(machine.initial)).toBe(true);
    // No `onCancel` (the inline default cancel) and no `migrate` (a function
    // definition's checkpoint carries no shape).
    expect("onCancel" in machine).toBe(false);
    expect("migrate" in machine).toBe(false);
  });

  it("runs the function with the run seed and settles on its return", async () => {
    const seen: unknown[] = [];
    const machine = compileTaskFunction(
      async (input: never, step: StateMachineStep) => {
        seen.push(input);
        seen.push(step.attempt);
        return { ok: true };
      }
    );

    const ctx = stubContext({ topic: "chips" });
    const returned = await machine.phases[COMPILED_PHASE](
      COMPILED_CHECKPOINT,
      ctx
    );

    expect(seen).toEqual([{ topic: "chips" }, 1]);
    // `ctx` IS `step`: the function received the object the phase was handed.
    expect(returned).toEqual({ kind: "complete", result: { ok: true } });
  });

  it("returns the same compiled machine for one function", () => {
    const fn = async () => "x";
    expect(compileTaskFunction(fn)).toBe(compileTaskFunction(fn));
  });

  it("tells a machine definition from a durable function", () => {
    const machine = {
      initial: { phase: "idle" } as { phase: "idle" },
      phases: { idle: async (state: { phase: "idle" }) => state }
    } satisfies StateMachineDefinition<{ phase: "idle" }>;

    expect(isTaskFunction(machine)).toBe(false);
    expect(isTaskFunction(async () => "x")).toBe(true);
  });

  it("reads a terminal back only from a terminal signal", async () => {
    const machine = compileTaskFunction(async () => 7);
    const returned = await machine.phases[COMPILED_PHASE](
      COMPILED_CHECKPOINT,
      stubContext(undefined)
    );
    // The stub's terminal is a plain object, not the engine's signal class.
    expect(readTaskTerminal(returned)).toBeUndefined();
    expect(readTaskTerminal({ phase: "idle" })).toBeUndefined();
    expect(readTaskTerminal(undefined)).toBeUndefined();
  });

  it("propagates a throw from the function rather than settling", async () => {
    const machine = compileTaskFunction(async () => {
      throw new Error("boom");
    });

    await expect(
      machine.phases[COMPILED_PHASE](
        COMPILED_CHECKPOINT,
        stubContext(undefined)
      )
    ).rejects.toThrow("boom");
  });
});

describe("step idempotency keys", () => {
  it("omits the turn segment for a compiled function definition", () => {
    expect(
      taskIdempotencyKey("run_1", "charge", { turn: 0, compiled: true })
    ).toBe("run_1:charge");
    // The turn is never anything but 0 for a compiled definition, but the
    // key form does not depend on it either way.
    expect(
      taskIdempotencyKey("run_1", "charge", { turn: 4, compiled: true })
    ).toBe("run_1:charge");
  });

  it("scopes a machine transition's key to its turn", () => {
    expect(
      taskIdempotencyKey("run_1", "charge", { turn: 0, compiled: false })
    ).toBe("run_1:t0:charge");
    expect(
      taskIdempotencyKey("run_1", "charge", { turn: 7, compiled: false })
    ).toBe("run_1:t7:charge");
  });

  it("gives either form the turn-free key under scope run", () => {
    expect(
      taskIdempotencyKey("run_1", "charge", {
        turn: 7,
        compiled: false,
        scope: "run"
      })
    ).toBe("run_1:charge");
    expect(
      taskIdempotencyKey("run_1", "charge", {
        turn: 0,
        compiled: true,
        scope: "run"
      })
    ).toBe("run_1:charge");
  });
});

describe("checkpoint serialization", () => {
  it("persists the compiled singleton as SQL NULL", () => {
    // The whole point of the singleton: an upgraded run's `checkpoint`
    // column stays the NULL the version 2 rows already carry, which is what
    // pins a function definition's turn at 0.
    expect(serializeTaskCheckpoint(COMPILED_CHECKPOINT, "probe")).toBeNull();
    expect(serializeTaskCheckpoint(undefined, "probe")).toBeNull();
  });

  it("serializes a machine's own checkpoint as JSON", () => {
    // Structurally identical to the singleton, but not the singleton: the
    // test is identity, so a machine that happens to name a phase "run"
    // still persists its state.
    expect(serializeTaskCheckpoint({ phase: COMPILED_PHASE }, "probe")).toBe(
      '{"phase":"run"}'
    );
    expect(serializeTaskCheckpoint({ phase: "idle", turns: 2 }, "probe")).toBe(
      '{"phase":"idle","turns":2}'
    );
  });

  it("refuses a checkpoint above the cap, which is a quarter of the value cap", () => {
    // One byte under and one byte over the ceiling, so the comparison
    // itself is pinned rather than the order of magnitude. The JSON
    // envelope around the blob costs 21 bytes.
    const envelope = '{"phase":"idle","blob":""}'.length;
    const fits = {
      phase: "idle",
      blob: "a".repeat(MAX_CHECKPOINT_BYTES - envelope)
    };
    expect(serializeTaskCheckpoint(fits, "probe")).toHaveLength(
      MAX_CHECKPOINT_BYTES
    );

    const oversized = { phase: "idle", blob: "a".repeat(MAX_CHECKPOINT_BYTES) };
    expect(() => serializeTaskCheckpoint(oversized, "probe")).toThrow(
      StateMachineCheckpointTooLargeError
    );
    // The cap is deliberately tighter than the one-shot value cap: a
    // checkpoint is rewritten every transition.
    expect(MAX_CHECKPOINT_BYTES).toBe(MAX_SERIALIZED_BYTES / 4);
  });

  it("reports the refused size, the limit, and its serialization lineage", () => {
    let thrown: unknown;
    try {
      serializeTaskCheckpoint(
        { phase: "idle", blob: "a".repeat(MAX_CHECKPOINT_BYTES) },
        'checkpoint for definition "chat@v1"'
      );
    } catch (error) {
      thrown = error;
    }
    // The subclass relationship is the contract: a host catching
    // `StateMachineSerializationError` already handles an oversized checkpoint.
    expect(thrown).toBeInstanceOf(StateMachineCheckpointTooLargeError);
    expect(thrown).toBeInstanceOf(StateMachineSerializationError);
    if (!(thrown instanceof StateMachineCheckpointTooLargeError)) {
      throw new Error("unreachable");
    }
    expect(thrown.name).toBe("StateMachineCheckpointTooLargeError");
    expect(thrown.limit).toBe(MAX_CHECKPOINT_BYTES);
    expect(thrown.bytes).toBeGreaterThan(MAX_CHECKPOINT_BYTES);
    expect(thrown.message).toContain('checkpoint for definition "chat@v1"');
  });

  it("refuses a member JSON cannot carry, naming its key path", () => {
    // `JSON.stringify` is silent about both of these — the function member
    // simply disappears and the stream becomes `{}` — so a checkpoint
    // holding a live handle would persist as something plausible and come
    // back as something else. This is the runtime half of `AssertJson`,
    // which a definition only opts into at the type level.
    expect(() =>
      serializeTaskCheckpoint(
        { phase: "idle", body: new ReadableStream() },
        'checkpoint for definition "chat@v1"'
      )
    ).toThrow(
      /value at "body" of type ReadableStream has no JSON representation/
    );
    expect(() =>
      serializeTaskCheckpoint(
        { phase: "idle", asks: [{ id: "a1", retry: () => {} }] },
        'checkpoint for definition "chat@v1"'
      )
    ).toThrow(
      /value at "asks\[0\].retry" of type function has no JSON representation/
    );
    // The context travels with the path, so the message names both the
    // definition and the member.
    expect(() =>
      serializeTaskCheckpoint(
        { phase: "idle", at: new Date(0) },
        'checkpoint for definition "chat@v1"'
      )
    ).toThrow(StateMachineSerializationError);
  });

  it("refuses a cycle rather than letting the stringify throw name nothing", () => {
    const state: { phase: string; self?: unknown } = { phase: "idle" };
    state.self = state;
    expect(() => serializeTaskCheckpoint(state, "probe")).toThrow(
      /value at "self" is a circular reference/
    );
    // A value repeated across siblings is not a cycle: JSON writes it twice.
    const shared = { id: "a1" };
    expect(
      serializeTaskCheckpoint({ phase: "idle", a: shared, b: shared }, "probe")
    ).toBe('{"phase":"idle","a":{"id":"a1"},"b":{"id":"a1"}}');
  });

  it("accepts the shapes a state is ordinarily spelled in", () => {
    // What `AssertJson` accepts at the type level, accepted here at
    // runtime: primitives, nulls, arrays, nested plain objects, and
    // `undefined` members, which JSON drops exactly as the type allows.
    interface ChatState {
      readonly phase: "idle";
      readonly turns: number;
      readonly last: string | null;
      readonly pending: ReadonlyArray<{ readonly id: string }>;
      readonly note?: string;
    }
    const state: ChatState = {
      phase: "idle",
      turns: 2,
      last: null,
      pending: [{ id: "a1" }, { id: "a2" }],
      note: undefined
    };
    expect(serializeTaskCheckpoint(state, "probe")).toBe(
      '{"phase":"idle","turns":2,"last":null,"pending":[{"id":"a1"},{"id":"a2"}]}'
    );
    // A null-prototype bag is still a plain bag to JSON.
    expect(
      serializeTaskCheckpoint(
        Object.assign(Object.create(null), { phase: "idle" }),
        "probe"
      )
    ).toBe('{"phase":"idle"}');
  });
});

describe("ask kinds", () => {
  it("carries nothing but the name it is answered by", () => {
    // The answer type travels with the kind at the type level only: what
    // persists, and what a typed `answer()` checks an id against, is this
    // one string. Anything else on the object would have to be serialized.
    expect(defineAsk<{ toolCallId: string }, boolean>("tool-approval")).toEqual(
      { name: "tool-approval" }
    );
  });

  it("refuses a name that could not identify an ask", () => {
    expect(() => defineAsk("")).toThrow(/non-empty/);
    // SAFETY: the guard exists for untyped callers, so the probe has to
    // reach it the way one would.
    expect(() => (defineAsk as (name: unknown) => unknown)(7)).toThrow(
      /non-empty/
    );
  });
});

describe("the child mailbox key", () => {
  it("keys a settlement note by the child, so a repeat collapses", () => {
    expect(childMailboxKey("run_7")).toBe("child:run_7");
    expect(childMailboxKey("run_7")).toBe(childMailboxKey("run_7"));
    expect(CHILD_MAILBOX_KIND).toBe("child");
  });
});

describe("definition names", () => {
  it("splits on the last @v followed only by digits", () => {
    expect(parseDefinitionName("chat")).toEqual({ base: "chat", version: 0 });
    expect(parseDefinitionName("chat@v1")).toEqual({
      base: "chat",
      version: 1
    });
    expect(parseDefinitionName("chat@v12")).toEqual({
      base: "chat",
      version: 12
    });
    expect(parseDefinitionName("chat@v2@v11")).toEqual({
      base: "chat@v2",
      version: 11
    });
  });

  it("treats anything else as part of the base", () => {
    // Not digits.
    expect(parseDefinitionName("chat@vX")).toEqual({
      base: "chat@vX",
      version: 0
    });
    // Not a positive version.
    expect(parseDefinitionName("chat@v0")).toEqual({
      base: "chat@v0",
      version: 0
    });
    // No base to version.
    expect(parseDefinitionName("@v1")).toEqual({ base: "@v1", version: 0 });
    // Reserved names version like any other.
    expect(parseDefinitionName("__cf_internal_chat_turn")).toEqual({
      base: "__cf_internal_chat_turn",
      version: 0
    });
  });
});
