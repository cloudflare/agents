/**
 * End-to-end tests for the durable codemode runtime, driven through a real
 * Durable Object host + CodemodeRuntime facet + DynamicWorkerExecutor sandbox.
 *
 * These cover the behaviour the mock-based unit tests can't: the connector RPC
 * binding, abort-and-replay across a real pause/approve cycle, rejection,
 * rollback, replay divergence, step replay, concurrent executions, and
 * execution retention.
 */
import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import type { ProxyToolOutput } from "../proxy-tool";
import type { ExecutionState, PendingAction } from "../runtime";
import type { Snippet } from "../snippet";

// The host's RPC methods, typed concretely. We don't lean on
// `DurableObjectNamespace<CodemodeTestHost>` here: the Workers RPC stub mapping
// collapses these structured return types to `never`, so we describe the slice
// of the host surface the tests use directly. The runtime-tests also run under
// their own wrangler config (see vitest.runtime.config.ts), so the binding
// isn't in the package's generated `Env`.
type SideEffects = {
  created: Array<{ title: string }>;
  deleted: unknown[];
  notes: string[];
};

interface Host {
  run(
    code: string,
    options?: { maxExecutions?: number }
  ): Promise<ProxyToolOutput>;
  approve(executionId: string): Promise<ProxyToolOutput>;
  reject(seq: number, executionId: string): Promise<void>;
  rollback(executionId: string): Promise<void>;
  pending(executionId?: string): Promise<PendingAction[]>;
  executions(): Promise<ExecutionState[]>;
  deleteExecution(id: string): Promise<boolean>;
  saveSnippet(
    name: string,
    description: string,
    executionId: string
  ): Promise<Snippet>;
  snippets(): Promise<Snippet[]>;
  sideEffects(): Promise<SideEffects>;
  lifecycle(): Promise<{
    opened: string[];
    disposed: Array<{ executionId: string; status: string }>;
  }>;
  enableShaping(): Promise<void>;
  raceRejectDuringApprovedExecute(): Promise<{
    decisionKind: string;
    duringExecute?: string;
    rejected: boolean;
    statusAfterReject?: string;
    stateAfterReject?: string;
    stateFinal?: string;
  }>;
}

const testEnv = env as unknown as {
  CodemodeTestHost: DurableObjectNamespace;
};

let counter = 0;
function host(): Host {
  // Fresh DO per test so executions/state never bleed across tests.
  const name = `host-${Date.now()}-${counter++}`;
  return testEnv.CodemodeTestHost.get(
    testEnv.CodemodeTestHost.idFromName(name)
  ) as unknown as Host;
}

describe("codemode durable runtime (e2e)", () => {
  it("runs a read-only connector call to completion over real RPC", async () => {
    const h = host();
    const out = (await h.run(
      `async () => await items.list_items()`
    )) as ProxyToolOutput;

    expect(out.status).toBe("completed");
    if (out.status === "completed") expect(out.result).toEqual([]);
  });

  it("pauses on an approval-gated action, then resumes on approve", async () => {
    const h = host();
    const first = (await h.run(
      `async () => await items.create_item({ title: "hello" })`
    )) as ProxyToolOutput;

    expect(first.status).toBe("paused");
    if (first.status !== "paused") return;
    expect(first.pending).toHaveLength(1);
    expect(first.pending[0]).toMatchObject({
      connector: "items",
      method: "create_item",
      args: { title: "hello" }
    });

    // Not applied yet.
    expect((await h.sideEffects()).created).toEqual([]);

    const resumed = (await h.approve(first.executionId)) as ProxyToolOutput;
    expect(resumed.status).toBe("completed");
    if (resumed.status === "completed") {
      expect(resumed.result).toMatchObject({ id: 1, title: "hello" });
    }
    // Applied exactly once.
    expect((await h.sideEffects()).created).toEqual([{ title: "hello" }]);
  });

  it("replays prior reads from the log instead of re-executing them", async () => {
    const h = host();
    // A read before the approval pause. On resume the read must NOT run again.
    const code = `async () => {
      const before = await items.list_items();
      const created = await items.create_item({ title: "x" });
      return { beforeCount: before.length, created };
    }`;
    const first = (await h.run(code)) as ProxyToolOutput;
    expect(first.status).toBe("paused");
    if (first.status !== "paused") return;

    const resumed = (await h.approve(first.executionId)) as ProxyToolOutput;
    expect(resumed.status).toBe("completed");
    if (resumed.status === "completed") {
      // list_items replayed its original (empty) result, even though
      // create_item has since mutated state.
      expect(resumed.result).toMatchObject({ beforeCount: 0 });
    }
    expect((await h.sideEffects()).created).toEqual([{ title: "x" }]);
  });

  it("rejecting a pending action ends the execution without applying it", async () => {
    const h = host();
    const first = (await h.run(
      `async () => await items.create_item({ title: "nope" })`
    )) as ProxyToolOutput;
    expect(first.status).toBe("paused");
    if (first.status !== "paused") return;

    await h.reject(first.pending[0].seq, first.executionId);

    expect((await h.sideEffects()).created).toEqual([]);
    const execs = await h.executions();
    const exec = execs.find((e) => e.id === first.executionId);
    expect(exec?.status).toBe("rejected");
  });

  it("refuses to approve a terminal run, never re-offering a rejected action", async () => {
    const h = host();
    const first = (await h.run(
      `async () => await items.create_item({ title: "nope" })`
    )) as ProxyToolOutput;
    expect(first.status).toBe("paused");
    if (first.status !== "paused") return;

    await h.reject(first.pending[0].seq, first.executionId);

    // Approving a now-rejected run must NOT revive it (which would re-offer the
    // rejected action for approval or re-run its code). It returns an error
    // outcome and leaves the run terminal.
    const resumed = (await h.approve(first.executionId)) as ProxyToolOutput;
    expect(resumed.status).toBe("error");
    if (resumed.status === "error") {
      expect(resumed.error).toMatch(/not paused/);
    }

    // No new pending action was created and no side effect leaked through.
    expect((await h.pending()).length).toBe(0);
    expect((await h.sideEffects()).created).toEqual([]);
    const exec = (await h.executions()).find((e) => e.id === first.executionId);
    expect(exec?.status).toBe("rejected");
  });

  it("rolls back applied actions in reverse, including non-approval writes", async () => {
    const h = host();
    // add_note (no approval) runs immediately; create_item pauses.
    const code = `async () => {
      await items.add_note({ text: "first" });
      return await items.create_item({ title: "second" });
    }`;
    const first = (await h.run(code)) as ProxyToolOutput;
    expect(first.status).toBe("paused");
    if (first.status !== "paused") return;
    const resumed = (await h.approve(first.executionId)) as ProxyToolOutput;
    expect(resumed.status).toBe("completed");

    let fx = await h.sideEffects();
    expect(fx.created).toEqual([{ title: "second" }]);
    expect(fx.notes).toEqual(["first"]);

    await h.rollback(first.executionId);

    fx = await h.sideEffects();
    // create_item reverted (its result pushed to deleted), note reverted.
    expect(fx.deleted).toEqual([{ id: 1, title: "second" }]);
    expect(fx.notes).toEqual(["__reverted__"]);

    // The rollback is reflected in the execution status (not left "completed").
    const execs = await h.executions();
    expect(execs.find((e) => e.id === first.executionId)?.status).toBe(
      "rolled_back"
    );
  });

  it("does not apply anything when model code swallows the pause", async () => {
    const h = host();
    // The model wraps the approval-gated call in try/catch and keeps going,
    // attempting a second write. The runtime's terminal-state guard must stop
    // every further call, so nothing is applied and the run still pauses.
    const code = `async () => {
      try {
        await items.create_item({ title: "one" });
      } catch (e) {
        // swallow the pause and try to do more
      }
      try {
        await items.create_item({ title: "two" });
      } catch (e) {}
      return "done";
    }`;
    const out = (await h.run(code)) as ProxyToolOutput;

    expect(out.status).toBe("paused");
    if (out.status !== "paused") return;
    // Only the first action is pending; the swallowed-and-retried call never
    // got logged or applied.
    expect(out.pending).toHaveLength(1);
    expect(out.pending[0]).toMatchObject({ method: "create_item" });
    expect((await h.sideEffects()).created).toEqual([]);
  });

  it("aggregates pending actions across concurrent paused executions", async () => {
    const h = host();
    const a = (await h.run(
      `async () => await items.create_item({ title: "A" })`
    )) as ProxyToolOutput;
    const b = (await h.run(
      `async () => await items.create_item({ title: "B" })`
    )) as ProxyToolOutput;
    expect(a.status).toBe("paused");
    expect(b.status).toBe("paused");

    // pending() with no executionId must surface BOTH paused runs, not just
    // whichever was started last.
    const pending = await h.pending();
    expect(pending).toHaveLength(2);
    const titles = pending
      .map((p) => (p.args as { title: string }).title)
      .sort();
    expect(titles).toEqual(["A", "B"]);
  });

  it("detects replay divergence when approval-call args change across runs", async () => {
    const h = host();
    // Math.random() is NOT wrapped in a step, so the recorded args differ on
    // resume → the runtime must refuse rather than silently apply stale args.
    const code = `async () => await items.create_item({ title: "t" + Math.random() })`;
    const first = (await h.run(code)) as ProxyToolOutput;
    expect(first.status).toBe("paused");
    if (first.status !== "paused") return;

    const resumed = (await h.approve(first.executionId)) as ProxyToolOutput;
    expect(resumed.status).toBe("error");
    if (resumed.status === "error") {
      expect(resumed.error).toMatch(/divergence/i);
    }
    // Nothing applied.
    expect((await h.sideEffects()).created).toEqual([]);

    // The diverged run ended as "error" but its log still carries the original
    // "pending" entry. That entry is NOT actionable (approve is a no-op now), so
    // it must not surface in the approval queue — neither aggregated nor scoped.
    expect(await h.pending()).toEqual([]);
    expect(await h.pending(first.executionId)).toEqual([]);
  });

  it("codemode.step makes nondeterministic work replay-safe", async () => {
    const h = host();
    // Same shape as the divergence test, but the random value is captured in a
    // step, so it replays identically and the approval call's args match.
    const code = `async () => {
      const r = await codemode.step("rand", () => Math.random());
      return await items.create_item({ title: "t" + r });
    }`;
    const first = (await h.run(code)) as ProxyToolOutput;
    expect(first.status).toBe("paused");
    if (first.status !== "paused") return;

    const resumed = (await h.approve(first.executionId)) as ProxyToolOutput;
    expect(resumed.status).toBe("completed");
    expect((await h.sideEffects()).created).toHaveLength(1);
  });

  it("a reject racing an approved action's execution no-ops (no revert mid-run)", async () => {
    const h = host();
    const r = await h.raceRejectDuringApprovedExecute();

    // The approved call is decided for execution and marked "executing" before
    // decide() returns, closing the window a concurrent reject could exploit.
    expect(r.decisionKind).toBe("execute");
    expect(r.duringExecute).toBe("executing");
    // The racing reject sees "executing", so it no-ops and leaves the run alone.
    expect(r.rejected).toBe(false);
    expect(r.statusAfterReject).toBe("running");
    expect(r.stateAfterReject).toBe("executing");
    // The action records normally — it was applied, not reverted.
    expect(r.stateFinal).toBe("applied");
  });

  it("a throwing connector tool ends the run as error without rejecting across RPC", async () => {
    const h = host();
    // boom() throws on the host. The binding must surface that as an error
    // marker (not an RPC rejection), so the run ends "error" with the message
    // and — crucially — the test completes without an unhandled rejection.
    const out = (await h.run(
      `async () => { await items.boom(); return "unreachable"; }`
    )) as ProxyToolOutput;

    expect(out.status).toBe("error");
    if (out.status === "error") {
      expect(out.error).toMatch(/connector boom/);
    }
    const exec = (await h.executions()).find((e) => e.id === out.executionId);
    expect(exec?.status).toBe("error");
  });

  it("runs two executions concurrently without clobbering each other", async () => {
    const h = host();
    const [a, b] = (await Promise.all([
      h.run(`async () => { await items.list_items(); return "A"; }`),
      h.run(`async () => { await items.list_items(); return "B"; }`)
    ])) as ProxyToolOutput[];

    expect(a.status).toBe("completed");
    expect(b.status).toBe("completed");
    const results = [a, b].map((o) =>
      o.status === "completed" ? o.result : null
    );
    expect(results.sort()).toEqual(["A", "B"]);

    const execs = await h.executions();
    const completed = execs.filter((e) => e.status === "completed");
    expect(completed.length).toBeGreaterThanOrEqual(2);
    // Distinct execution ids.
    expect(new Set(execs.map((e) => e.id)).size).toBe(execs.length);
  });

  it("retains only the newest terminal executions (auto-prune)", async () => {
    const h = host();
    for (let i = 0; i < 5; i++) {
      const out = (await h.run(`async () => ${i}`, {
        maxExecutions: 2
      })) as ProxyToolOutput;
      expect(out.status).toBe("completed");
    }
    const execs = await h.executions();
    // At most `maxExecutions` terminal + the just-finished current.
    expect(execs.length).toBeLessThanOrEqual(3);
  });

  it("saves a completed run as a snippet and re-runs it", async () => {
    const h = host();
    const out = (await h.run(
      `async (input) => "ran:" + (input ?? "none")`
    )) as ProxyToolOutput;
    expect(out.status).toBe("completed");
    if (out.status !== "completed") return;

    // The completed output carries the execution id — no need to guess "newest".
    await h.saveSnippet("greet", "says hi", out.executionId);
    const snippets = await h.snippets();
    expect(snippets.map((s) => s.name)).toContain("greet");

    const reuse = (await h.run(
      `async () => await codemode.run("greet", "world")`
    )) as ProxyToolOutput;
    expect(reuse.status).toBe("completed");
    if (reuse.status === "completed") expect(reuse.result).toBe("ran:world");
  });

  it("re-runs a snippet saved from fenced or statement-style code", async () => {
    const h = host();

    // Markdown-fenced model output: valid at run time (the executor normalizes
    // it) but the raw fenced text is what gets stored on the snippet.
    const fenced = "```ts\nasync () => { return 42; }\n```";
    const a = (await h.run(fenced)) as ProxyToolOutput;
    expect(a.status).toBe("completed");
    if (a.status !== "completed") return;
    expect(a.result).toBe(42);
    await h.saveSnippet("answer", "returns the answer", a.executionId);

    // A statement block (no arrow wrapper, top-level return) — also only valid
    // after normalization.
    const block = `const list = await items.list_items();\nreturn list.length;`;
    const b = (await h.run(block)) as ProxyToolOutput;
    expect(b.status).toBe("completed");
    if (b.status !== "completed") return;
    await h.saveSnippet("count", "counts items", b.executionId);

    // Re-running each snippet must normalize the stored raw code before
    // embedding it as an expression — otherwise the wrapper is a syntax error.
    const viaAnswer = (await h.run(
      `async () => await codemode.run("answer")`
    )) as ProxyToolOutput;
    expect(viaAnswer.status).toBe("completed");
    if (viaAnswer.status === "completed") expect(viaAnswer.result).toBe(42);

    const viaCount = (await h.run(
      `async () => await codemode.run("count")`
    )) as ProxyToolOutput;
    expect(viaCount.status).toBe("completed");
    if (viaCount.status === "completed") expect(viaCount.result).toBe(0);
  });

  it("deletes an execution from the audit trail", async () => {
    const h = host();
    await h.run(`async () => 1`);
    const before = await h.executions();
    expect(before.length).toBeGreaterThanOrEqual(1);
    const id = before[0].id;
    expect(await h.deleteExecution(id)).toBe(true);
    const after = await h.executions();
    expect(after.find((e) => e.id === id)).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Per-execution connector lifecycle (acquire/dispose across pause/resume)
  // -------------------------------------------------------------------------

  it("threads the executionId into a tool's execute context", async () => {
    const h = host();
    const out = (await h.run(
      `async () => await items.session_id()`
    )) as ProxyToolOutput;

    expect(out.status).toBe("completed");
    if (out.status !== "completed") return;
    // The id the tool saw equals the run's execution id.
    expect(out.result).toEqual({ executionId: out.executionId });
    expect((await h.lifecycle()).opened).toContain(out.executionId);
  });

  it("disposes connectors once when a run completes", async () => {
    const h = host();
    const out = (await h.run(
      `async () => await items.session_id()`
    )) as ProxyToolOutput;
    expect(out.status).toBe("completed");
    if (out.status !== "completed") return;

    const { disposed } = await h.lifecycle();
    expect(disposed).toEqual([
      { executionId: out.executionId, status: "completed" }
    ]);
  });

  it("does not dispose while paused, then disposes on approve", async () => {
    const h = host();
    const first = (await h.run(
      `async () => await items.create_item({ title: "hello" })`
    )) as ProxyToolOutput;
    expect(first.status).toBe("paused");
    if (first.status !== "paused") return;

    // Paused is not terminal — the resource must stay open for the resume.
    expect((await h.lifecycle()).disposed).toEqual([]);

    const resumed = (await h.approve(first.executionId)) as ProxyToolOutput;
    expect(resumed.status).toBe("completed");

    // Disposed exactly once, on the terminal (completed) transition.
    expect((await h.lifecycle()).disposed).toEqual([
      { executionId: first.executionId, status: "completed" }
    ]);
  });

  it("disposes with 'rejected' when a pending action is rejected", async () => {
    const h = host();
    const first = (await h.run(
      `async () => await items.create_item({ title: "nope" })`
    )) as ProxyToolOutput;
    expect(first.status).toBe("paused");
    if (first.status !== "paused") return;

    expect((await h.lifecycle()).disposed).toEqual([]);

    await h.reject(first.pending[0].seq, first.executionId);

    expect((await h.lifecycle()).disposed).toEqual([
      { executionId: first.executionId, status: "rejected" }
    ]);
  });

  it("does not dispose on a stale reject that doesn't terminate the run", async () => {
    const h = host();
    const first = (await h.run(
      `async () => await items.create_item({ title: "stale" })`
    )) as ProxyToolOutput;
    expect(first.status).toBe("paused");
    if (first.status !== "paused") return;

    // A seq that isn't pending (no such entry) — reject is a no-op, so the run
    // stays paused/resumable and its resources must NOT be torn down.
    await h.reject(999, first.executionId);
    expect((await h.lifecycle()).disposed).toEqual([]);

    // The run is still live: approving it completes normally.
    const resumed = (await h.approve(first.executionId)) as ProxyToolOutput;
    expect(resumed.status).toBe("completed");
    expect((await h.lifecycle()).disposed).toEqual([
      { executionId: first.executionId, status: "completed" }
    ]);
  });

  it("disposes with 'rolled_back' after a rollback reverts effects", async () => {
    const h = host();
    const out = (await h.run(
      `async () => await items.add_note({ text: "hi" })`
    )) as ProxyToolOutput;
    expect(out.status).toBe("completed");
    if (out.status !== "completed") return;

    // Completed first, so dispose fired once with "completed".
    expect((await h.lifecycle()).disposed).toEqual([
      { executionId: out.executionId, status: "completed" }
    ]);

    await h.rollback(out.executionId);

    // Rollback is a second terminal transition — dispose fires again.
    expect((await h.lifecycle()).disposed).toEqual([
      { executionId: out.executionId, status: "completed" },
      { executionId: out.executionId, status: "rolled_back" }
    ]);
  });

  // -------------------------------------------------------------------------
  // transformResult — reshape the model-facing result (run + resume)
  // -------------------------------------------------------------------------

  it("applies transformResult to the result on both run and resume", async () => {
    const h = host();
    await h.enableShaping();

    // Initial run: a completed read is shaped.
    const read = (await h.run(
      `async () => await items.list_items()`
    )) as ProxyToolOutput;
    expect(read.status).toBe("completed");
    if (read.status === "completed") {
      expect(read.result).toEqual({ shaped: [] });
    }

    // Resume after approval: the result is shaped on the resume pass too.
    const first = (await h.run(
      `async () => await items.create_item({ title: "z" })`
    )) as ProxyToolOutput;
    expect(first.status).toBe("paused");
    if (first.status !== "paused") return;

    const resumed = (await h.approve(first.executionId)) as ProxyToolOutput;
    expect(resumed.status).toBe("completed");
    if (resumed.status === "completed") {
      expect(resumed.result).toEqual({ shaped: { id: 1, title: "z" } });
    }

    // The raw (unshaped) result is preserved on the execution audit trail.
    const execs = await h.executions();
    const rec = execs.find((e) => e.id === first.executionId);
    expect(rec?.result).toEqual({ id: 1, title: "z" });
  });
});
