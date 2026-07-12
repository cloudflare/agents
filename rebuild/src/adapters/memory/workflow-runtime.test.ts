import { describe, expect, it } from "vitest";
import { createMemoryWorkflowRuntime } from "./workflow-runtime.js";

describe("createMemoryWorkflowRuntime", () => {
  it("status() is null before create()", async () => {
    const rt = createMemoryWorkflowRuntime();
    expect(await rt.status("wf", "id1")).toBeNull();
  });

  it("create() initializes status to running", async () => {
    const rt = createMemoryWorkflowRuntime();
    await rt.create("wf", { id: "id1", params: { a: 1 } });
    expect(await rt.status("wf", "id1")).toEqual({ status: "running" });
  });

  it("setStatus() lets a test flip the status directly", async () => {
    const rt = createMemoryWorkflowRuntime();
    await rt.create("wf", { id: "id1" });
    rt.setStatus("wf", "id1", { status: "complete", output: { ok: true } });
    expect(await rt.status("wf", "id1")).toEqual({ status: "complete", output: { ok: true } });
  });

  it("setStatus() invokes registered progress callbacks", async () => {
    const rt = createMemoryWorkflowRuntime();
    await rt.create("wf", { id: "id1" });
    const seen: unknown[] = [];
    rt.onProgress((name, id, status) => seen.push({ name, id, status }));
    rt.setStatus("wf", "id1", { status: "complete" });
    expect(seen).toEqual([{ name: "wf", id: "id1", status: { status: "complete" } }]);
  });

  it("onProgress() returns an unsubscribe function", async () => {
    const rt = createMemoryWorkflowRuntime();
    await rt.create("wf", { id: "id1" });
    const seen: unknown[] = [];
    const unsubscribe = rt.onProgress((...args) => seen.push(args));
    unsubscribe();
    rt.setStatus("wf", "id1", { status: "complete" });
    expect(seen).toEqual([]);
  });

  it("terminate()/pause()/resume()/restart() update status", async () => {
    const rt = createMemoryWorkflowRuntime();
    await rt.create("wf", { id: "id1" });
    await rt.pause("wf", "id1");
    expect((await rt.status("wf", "id1"))?.status).toBe("paused");
    await rt.resume("wf", "id1");
    expect((await rt.status("wf", "id1"))?.status).toBe("running");
    await rt.terminate("wf", "id1");
    expect((await rt.status("wf", "id1"))?.status).toBe("terminated");
    await rt.restart("wf", "id1");
    expect((await rt.status("wf", "id1"))?.status).toBe("running");
  });

  it("sendEvent() records the event for later inspection", async () => {
    const rt = createMemoryWorkflowRuntime();
    await rt.create("wf", { id: "id1" });
    await rt.sendEvent("wf", "id1", { type: "approve", payload: { ok: true } });
    expect(rt.eventsFor("wf", "id1")).toEqual([{ type: "approve", payload: { ok: true } }]);
  });

  it("keeps distinct instances isolated by name+id", async () => {
    const rt = createMemoryWorkflowRuntime();
    await rt.create("wf", { id: "id1" });
    await rt.create("wf", { id: "id2" });
    rt.setStatus("wf", "id1", { status: "complete" });
    expect((await rt.status("wf", "id1"))?.status).toBe("complete");
    expect((await rt.status("wf", "id2"))?.status).toBe("running");
  });
});
