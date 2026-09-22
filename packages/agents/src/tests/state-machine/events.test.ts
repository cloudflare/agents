import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createHarnessStub, waitFor } from "./test-harness";

describe("StateMachine events and waits", () => {
  it("parks without polling and resumes from a matching event", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startWaiter("approval");
    const waiting = await waitFor(stub, receipt.runId, ["waiting"]);
    expect(waiting.wait).toMatchObject({
      type: "message",
      key: "approval"
    });

    await expect(
      stub.sendMessage(receipt.runId, "approval", "accepted", "event-accepted")
    ).resolves.toMatchObject({ status: "accepted" });
    await expect(
      waitFor(stub, receipt.runId, ["completed"])
    ).resolves.toMatchObject({ result: "accepted" });
  });

  it("buffers an event delivered before the wait is observed", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startWaiter("early");
    await stub.sendMessage(receipt.runId, "early", "buffered", "event-early");

    await expect(
      waitFor(stub, receipt.runId, ["completed"])
    ).resolves.toMatchObject({ result: "buffered" });
  });

  it("deduplicates event IDs and rejects conflicting reuse", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startWaiter("dedupe");
    const first = await stub.sendMessage(
      receipt.runId,
      "dedupe",
      "one",
      "same-event"
    );
    expect(first.status).toBe("accepted");
    await expect(
      stub.sendMessage(receipt.runId, "dedupe", "one", "same-event")
    ).resolves.toMatchObject({ status: "duplicate", sequence: first.sequence });
    await expect(
      stub.sendMessageError(receipt.runId, "dedupe", "different", "same-event")
    ).resolves.toMatch(/different payload/);
  });

  it("does not wake for an unrelated key", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startWaiter("wanted");
    await waitFor(stub, receipt.runId, ["waiting"]);
    await stub.sendMessage(receipt.runId, "other", "ignored", "event-other");

    const snapshot = await stub.runSnapshot(receipt.runId);
    expect(snapshot?.status).toBe("waiting");
  });

  it("wakes at the persisted timeout", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startWaiter("timeout", 20);
    await expect(
      waitFor(stub, receipt.runId, ["completed"])
    ).resolves.toMatchObject({ result: "timed-out" });
  });

  it("restores an event wait after eviction", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startWaiter("evicted");
    await waitFor(stub, receipt.runId, ["waiting"]);
    await evictDurableObject(stub);
    await stub.sendMessage(
      receipt.runId,
      "evicted",
      "restored",
      "event-evicted"
    );

    await expect(
      waitFor(stub, receipt.runId, ["completed"])
    ).resolves.toMatchObject({ result: "restored" });
  });
});
