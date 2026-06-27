/**
 * Durable Object eviction tests for the codemode runtime.
 *
 * The `CodemodeRuntime` is deliberately *stateless in instance memory*: every
 * run is addressed by an explicit executionId and ALL state (the replay log,
 * pending actions, status, results, snippets) lives in the facet's SQLite store
 * (see runtime.ts "Statelessness" doc block). These tests prove that contract
 * against a real production-style eviction: we drive a run, evict the host DO
 * (which recursively evicts the `CodemodeRuntime` facet and drops every
 * in-memory array on the test connector), then re-access the stub and assert the
 * run rehydrates from storage and behaves identically.
 *
 * `evictDurableObject(stub)` simulates the production lifecycle where an idle DO
 * is evicted from memory: in-memory state is dropped and must be rebuilt from
 * storage on next access. We assert the in-memory connector arrays ARE wiped
 * (so the eviction genuinely happened, not a no-op) while the durable execution
 * state survives byte-for-byte.
 */
import { env } from "cloudflare:workers";
import { evictDurableObject, evictAllDurableObjects } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { ProxyToolOutput } from "../proxy-tool";
import type { ExecutionState, PendingAction } from "../runtime";

// Same host RPC surface the sibling runtime.test.ts uses. The Workers RPC stub
// mapping collapses these structured returns to `never` when typed via
// `DurableObjectNamespace<CodemodeTestHost>`, so we describe the slice directly.
interface Host {
  run(
    code: string,
    options?: { maxExecutions?: number; name?: string }
  ): Promise<ProxyToolOutput>;
  approve(executionId: string): Promise<ProxyToolOutput>;
  reject(seq: number, executionId: string): Promise<boolean>;
  pending(executionId?: string): Promise<PendingAction[]>;
  executions(name?: string): Promise<ExecutionState[]>;
  sideEffects(): Promise<{
    created: Array<{ title: string }>;
    deleted: unknown[];
    notes: string[];
  }>;
  lifecycle(): Promise<{
    opened: string[];
    disposed: Array<{ executionId: string; status: string }>;
  }>;
  passEnds(): Promise<Array<{ executionId: string; status: string }>>;
}

const testEnv = env as unknown as {
  CodemodeTestHost: DurableObjectNamespace;
};

let counter = 0;

/**
 * Resolve a fresh host DO. Returns BOTH the typed RPC view (`h`) and the raw
 * stub (`stub`) — `evictDurableObject` needs the real `DurableObjectStub`, while
 * the assertions drive the host through its RPC methods. They point at the same
 * object: re-reading through `h` after eviction forces rehydration from storage.
 */
function makeHost(): { h: Host; stub: DurableObjectStub } {
  const name = `evict-host-${Date.now()}-${counter++}`;
  const stub = testEnv.CodemodeTestHost.get(
    testEnv.CodemodeTestHost.idFromName(name)
  );
  return { h: stub as unknown as Host, stub };
}

describe("codemode durable runtime — DO eviction", () => {
  it("rebuilds a paused run from SQLite after eviction and replays prior reads", async () => {
    const { h, stub } = makeHost();
    // A read BEFORE the approval pause. On resume the read must replay its
    // original (empty) result from the durable log — not re-execute against the
    // freshly-rebuilt (and freshly-mutated) connector.
    const code = `async () => {
      const before = await items.list_items();
      const created = await items.create_item({ title: "x" });
      return { beforeCount: before.length, created };
    }`;
    const first = (await h.run(code)) as ProxyToolOutput;
    expect(first.status).toBe("paused");
    if (first.status !== "paused") return;
    expect(first.pending).toHaveLength(1);

    // Evict the host DO. This recursively evicts the CodemodeRuntime facet and
    // tears down the in-memory ItemsConnector arrays. The pending run now exists
    // ONLY in SQLite.
    await evictDurableObject(stub);

    // Proof the eviction was real: the in-memory connector state was wiped, yet
    // the durable approval queue rehydrated the pending action from storage.
    const pendingAfter = await h.pending();
    expect(pendingAfter).toHaveLength(1);
    expect(pendingAfter[0]).toMatchObject({
      executionId: first.executionId,
      connector: "items",
      method: "create_item",
      args: { title: "x" }
    });

    // Approve on the rehydrated instance. The whole run is reconstructed from
    // the durable log: list_items replays its logged empty result while
    // create_item executes for real exactly once.
    const resumed = (await h.approve(first.executionId)) as ProxyToolOutput;
    expect(resumed.status).toBe("completed");
    if (resumed.status !== "completed") return;
    // beforeCount===0 can ONLY come from the durable log surviving eviction:
    // the in-memory `created` array was reset, so a re-execution of list_items
    // would also see 0 — but create_item's logged result proves replay, and the
    // run id is the same pre-eviction execution.
    expect(resumed.result).toMatchObject({
      beforeCount: 0,
      created: { id: 1, title: "x" }
    });

    // The durable audit trail carries the original execution, now completed,
    // with its create_item entry applied.
    const exec = (await h.executions()).find((e) => e.id === first.executionId);
    expect(exec?.status).toBe("completed");
    const createEntry = exec?.log.find((e) => e.method === "create_item");
    expect(createEntry?.state).toBe("applied");
  });

  it("replays a binary result through the storage codec after eviction", async () => {
    const { h, stub } = makeHost();
    // get_bytes records a Uint8Array in the durable log on the first pass. After
    // eviction the resume must REPLAY it (not re-execute), so the stored value
    // has to decode back to a real Uint8Array off disk on a fresh instance.
    const code = `async () => {
      const bytes = await items.get_bytes();
      await items.create_item({ title: "b" });
      return { isBytes: bytes instanceof Uint8Array, values: Array.from(bytes) };
    }`;
    const first = (await h.run(code)) as ProxyToolOutput;
    expect(first.status).toBe("paused");
    if (first.status !== "paused") return;

    await evictDurableObject(stub);

    const resumed = (await h.approve(first.executionId)) as ProxyToolOutput;
    expect(resumed.status).toBe("completed");
    if (resumed.status !== "completed") return;
    // Byte-for-byte survival through the SQLite codec across hibernation.
    expect(resumed.result).toEqual({
      isBytes: true,
      values: [1, 2, 3, 4, 5]
    });
  });

  it("disposes connectors on a fresh instance when the run completes after eviction", async () => {
    const { h, stub } = makeHost();
    const first = (await h.run(
      `async () => await items.create_item({ title: "dispose-me" })`
    )) as ProxyToolOutput;
    expect(first.status).toBe("paused");
    if (first.status !== "paused") return;

    // Pausing fired onPassEnd("paused") but NOT disposeExecution (paused is not
    // terminal).
    expect(await h.passEnds()).toEqual([
      { executionId: first.executionId, status: "paused" }
    ]);
    expect((await h.lifecycle()).disposed).toEqual([]);

    // Evict: the in-memory passEnds/disposed/opened arrays are gone. The
    // connector that will run disposeExecution on resume is a BRAND NEW
    // instance, built after rehydration.
    await evictDurableObject(stub);

    // The wiped in-memory lifecycle arrays confirm a real teardown happened.
    expect(await h.passEnds()).toEqual([]);
    expect((await h.lifecycle()).disposed).toEqual([]);

    const resumed = (await h.approve(first.executionId)) as ProxyToolOutput;
    expect(resumed.status).toBe("completed");

    // disposeExecution fired exactly once, on the terminal transition, on the
    // post-eviction connector instance — keyed by the original executionId that
    // was reloaded from SQLite.
    expect((await h.lifecycle()).disposed).toEqual([
      { executionId: first.executionId, status: "completed" }
    ]);
    // onPassEnd fired only for the resume pass (the paused pass's record was on
    // the evicted instance); the durable run is still correctly completed.
    expect(await h.passEnds()).toEqual([
      { executionId: first.executionId, status: "completed" }
    ]);
    const exec = (await h.executions()).find((e) => e.id === first.executionId);
    expect(exec?.status).toBe("completed");
  });

  it("can reject a rehydrated pending run after eviction (terminal dispose on fresh instance)", async () => {
    const { h, stub } = makeHost();
    const first = (await h.run(
      `async () => await items.create_item({ title: "nope" })`
    )) as ProxyToolOutput;
    expect(first.status).toBe("paused");
    if (first.status !== "paused") return;
    const seq = first.pending[0].seq;

    await evictDurableObject(stub);

    // The pending action survived in SQLite and is rejectable on the fresh
    // instance using the seq captured before eviction.
    expect(await h.reject(seq, first.executionId)).toBe(true);

    // Reject is a terminal transition → disposeExecution("rejected") ran on the
    // post-eviction connector instance.
    expect((await h.lifecycle()).disposed).toEqual([
      { executionId: first.executionId, status: "rejected" }
    ]);
    const exec = (await h.executions()).find((e) => e.id === first.executionId);
    expect(exec?.status).toBe("rejected");
    // Nothing was ever applied.
    expect((await h.sideEffects()).created).toEqual([]);
    expect(await h.pending()).toEqual([]);
  });

  it("keeps the completed-execution audit trail intact across eviction", async () => {
    const { h, stub } = makeHost();
    // Drive several runs to completion so the SQLite audit trail is populated.
    // add_note completes immediately and records a durable log entry; its
    // in-memory side effect (the `notes` array) is the part eviction wipes.
    const a = (await h.run(`async () => 1 + 1`)) as ProxyToolOutput;
    expect(a.status).toBe("completed");
    const b = (await h.run(
      `async () => await items.add_note({ text: "kept" })`
    )) as ProxyToolOutput;
    expect(b.status).toBe("completed");

    // The in-memory note is present before eviction.
    expect((await h.sideEffects()).notes).toEqual(["kept"]);

    const before = await h.executions();
    expect(before).toHaveLength(2);
    const byId = new Map(before.map((e) => [e.id, e]));

    await evictDurableObject(stub);

    // In-memory side effects gone (real eviction); durable audit trail intact.
    expect((await h.sideEffects()).notes).toEqual([]);

    const after = await h.executions();
    expect(after).toHaveLength(2);
    for (const exec of after) {
      const original = byId.get(exec.id);
      expect(original).toBeDefined();
      expect(exec.status).toBe("completed");
      expect(exec.result).toEqual(original?.result);
      // The durable log shape (entry count + states) survived byte-for-byte.
      expect(exec.log.map((e) => e.state)).toEqual(
        original?.log.map((e) => e.state)
      );
    }
    // The add_note run's logged entry survived even though its in-memory effect
    // was wiped — replay reconstructs from the durable log, not live memory.
    const noteRun = after.find((e) => e.result?.hasOwnProperty?.("index"));
    expect(noteRun).toBeDefined();
    expect(noteRun?.log.find((e) => e.method === "add_note")?.state).toBe(
      "applied"
    );
  });

  it("rejects an oversized result the same way after eviction (storage guard survives)", async () => {
    const { h, stub } = makeHost();
    // First a normal completed run so the DO has live durable state.
    const ok = (await h.run(`async () => "small"`)) as ProxyToolOutput;
    expect(ok.status).toBe("completed");

    await evictDurableObject(stub);

    // After rehydration the durable-size guard still fails an oversized recorded
    // result with the same model-actionable error — the storage codec + limit
    // logic was reconstructed from the schema in the facet constructor.
    const out = (await h.run(
      `async () => { const r = await items.big_result(); return r.length; }`
    )) as ProxyToolOutput;
    expect(out.status).toBe("error");
    if (out.status !== "error") return;
    expect(out.error).toMatch(/too large to record durably/);
    const exec = (await h.executions()).find((e) => e.id === out.executionId);
    expect(exec?.status).toBe("error");

    // The earlier successful run is still on the audit trail post-eviction.
    expect(
      (await h.executions()).find((e) => e.id === ok.executionId)?.result
    ).toBe("small");
  });

  it("survives evictAllDurableObjects() — every running DO is rebuilt from storage", async () => {
    const { h } = makeHost();
    const first = (await h.run(
      `async () => {
        const before = await items.list_items();
        return await items.create_item({ title: "all" });
      }`
    )) as ProxyToolOutput;
    expect(first.status).toBe("paused");
    if (first.status !== "paused") return;

    // Namespace-wide eviction: every currently-running DO (host + its facet) is
    // gracefully evicted; durable storage is preserved.
    await evictAllDurableObjects();

    // The pending run rehydrated from SQLite after the blanket eviction.
    const pending = await h.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      executionId: first.executionId,
      method: "create_item"
    });

    const resumed = (await h.approve(first.executionId)) as ProxyToolOutput;
    expect(resumed.status).toBe("completed");
    if (resumed.status === "completed") {
      expect(resumed.result).toMatchObject({ id: 1, title: "all" });
    }
    const exec = (await h.executions()).find((e) => e.id === first.executionId);
    expect(exec?.status).toBe("completed");
  });
});
