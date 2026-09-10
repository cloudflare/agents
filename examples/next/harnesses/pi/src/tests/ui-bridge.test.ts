import { describe, expect, it } from "vitest";
import {
  createWebSocketUIContext,
  NoExtensionUiError
} from "../harness/extensions/ui-bridge";
import type { PiExtensionUiRequest } from "../harness/types";

/** A bridge over a fake lane that records every broadcast request. */
function bridgeWith(subscribers: number, timeoutMs = 10_000) {
  const sent: PiExtensionUiRequest[] = [];
  const settled: string[] = [];
  const bridge = createWebSocketUIContext({
    lane: "main",
    broadcast: (request) => {
      sent.push(request);
      return subscribers;
    },
    onSettled: (requestId) => settled.push(requestId),
    timeoutMs
  });
  return { ...bridge, sent, settled };
}

describe("ui bridge", () => {
  it("resolves a select with the client's value", async () => {
    const bridge = bridgeWith(1);
    const answer = bridge.ui.select("Pick", ["a", "b"]);
    expect(bridge.pending()).toBe(1);

    const request = bridge.sent[0];
    expect(request?.method).toBe("select");
    expect(bridge.resolve(request!.requestId, { value: "b" })).toBe(true);

    await expect(answer).resolves.toBe("b");
    expect(bridge.pending()).toBe(0);
  });

  it("refuses a dialog when no client is subscribed", async () => {
    const bridge = bridgeWith(0);
    await expect(bridge.ui.select("Pick", ["a"])).rejects.toBeInstanceOf(
      NoExtensionUiError
    );
    await expect(bridge.ui.confirm("Sure?", "really")).rejects.toBeInstanceOf(
      NoExtensionUiError
    );
    expect(bridge.sent).toHaveLength(2);
    expect(bridge.pending()).toBe(0);
  });

  it("times out an unanswered dialog with its default", async () => {
    const bridge = bridgeWith(1, 5);
    await expect(bridge.ui.input("Name", "who?")).resolves.toBeUndefined();
    expect(bridge.pending()).toBe(0);
  });

  it("times out an unanswered editor too", async () => {
    const bridge = bridgeWith(1, 5);
    await expect(bridge.ui.editor("Edit", "draft")).resolves.toBeUndefined();
  });

  it("honours a per-dialog timeout over the bridge default", async () => {
    const bridge = bridgeWith(1, 60_000);
    const answer = bridge.ui.confirm("Sure?", "really", { timeout: 5 });
    expect(bridge.sent[0]).toMatchObject({ method: "confirm", timeoutMs: 5 });
    await expect(answer).resolves.toBe(false);
  });

  it("treats a cancelled answer as the default", async () => {
    const bridge = bridgeWith(1);
    const selected = bridge.ui.select("Pick", ["a"]);
    const confirmed = bridge.ui.confirm("Sure?", "really");
    bridge.resolve(bridge.sent[0]!.requestId, { cancelled: true });
    bridge.resolve(bridge.sent[1]!.requestId, { cancelled: true });

    await expect(selected).resolves.toBeUndefined();
    await expect(confirmed).resolves.toBe(false);
  });

  it("answers an already-aborted signal without broadcasting", async () => {
    const bridge = bridgeWith(1);
    await expect(
      bridge.ui.select("Pick", ["a"], { signal: AbortSignal.abort() })
    ).resolves.toBeUndefined();
    expect(bridge.sent).toHaveLength(0);
  });

  it("settles on abort signal", async () => {
    const bridge = bridgeWith(1);
    const controller = new AbortController();
    const answer = bridge.ui.input("Name", undefined, {
      signal: controller.signal
    });
    controller.abort();
    await expect(answer).resolves.toBeUndefined();
    expect(bridge.pending()).toBe(0);
  });

  it("settles every open dialog with its default on abortAll", async () => {
    const bridge = bridgeWith(1);
    const selected = bridge.ui.select("Pick", ["a"]);
    const confirmed = bridge.ui.confirm("Sure?", "really");
    expect(bridge.pending()).toBe(2);

    bridge.abortAll("harness shutting down");

    await expect(selected).resolves.toBeUndefined();
    await expect(confirmed).resolves.toBe(false);
    expect(bridge.pending()).toBe(0);
  });

  it("announces a dialog the client answered", async () => {
    const bridge = bridgeWith(1);
    const answer = bridge.ui.select("Pick", ["a", "b"]);
    const requestId = bridge.sent[0]!.requestId;
    bridge.resolve(requestId, { value: "b" });

    await expect(answer).resolves.toBe("b");
    expect(bridge.settled).toEqual([requestId]);
  });

  it("announces a dialog it settled on its own timeout", async () => {
    const bridge = bridgeWith(1, 5);
    const answer = bridge.ui.input("Name", "who?");
    const requestId = bridge.sent[0]!.requestId;

    await expect(answer).resolves.toBeUndefined();
    // Without this the client's modal outlives the request behind it.
    expect(bridge.settled).toEqual([requestId]);
  });

  it("announces every dialog abortAll settles", async () => {
    const bridge = bridgeWith(1);
    const selected = bridge.ui.select("Pick", ["a"]);
    const confirmed = bridge.ui.confirm("Sure?", "really");
    const ids = bridge.sent.map((request) => request.requestId);

    bridge.abortAll("harness shutting down");

    await expect(selected).resolves.toBeUndefined();
    await expect(confirmed).resolves.toBe(false);
    expect(bridge.settled).toEqual(ids);
  });

  it("announces a dialog no client received", async () => {
    const bridge = bridgeWith(0);
    await expect(bridge.ui.confirm("Sure?", "really")).rejects.toBeInstanceOf(
      NoExtensionUiError
    );
    expect(bridge.settled).toEqual([bridge.sent[0]!.requestId]);
  });

  it("never announces a fire-and-forget view update", () => {
    const bridge = bridgeWith(1);
    bridge.ui.notify("saved");
    bridge.ui.setTitle("pi");
    expect(bridge.settled).toEqual([]);
  });

  it("ignores an answer to an unknown request", () => {
    const bridge = bridgeWith(1);
    expect(bridge.resolve("nope", { value: "x" })).toBe(false);
  });

  it("broadcasts view updates without holding a pending entry", () => {
    const bridge = bridgeWith(1);
    bridge.ui.notify("saved", "warning");
    bridge.ui.setStatus("guard", "armed");
    bridge.ui.setStatus("guard", undefined);
    bridge.ui.setWidget("hint", ["line one"], { placement: "belowEditor" });
    bridge.ui.setTitle("pi");
    bridge.ui.pasteToEditor("hello");

    expect(bridge.pending()).toBe(0);
    expect(bridge.sent.map((request) => request.method)).toEqual([
      "notify",
      "set_status",
      "set_status",
      "set_widget",
      "set_title",
      "set_editor_text"
    ]);
    expect(bridge.sent[0]).toMatchObject({
      message: "saved",
      level: "warning"
    });
    expect(bridge.sent[2]).toMatchObject({ key: "guard", text: undefined });
    expect(bridge.sent[3]).toMatchObject({
      lines: ["line one"],
      placement: "belowEditor"
    });
  });

  it("drops widget component factories", () => {
    const bridge = bridgeWith(1);
    bridge.ui.setWidget("hint", (() => undefined) as never);
    expect(bridge.sent).toHaveLength(0);
  });

  it("keeps terminal-only methods inert", () => {
    const bridge = bridgeWith(1);
    expect(bridge.ui.getEditorText()).toBe("");
    expect(bridge.ui.getToolsExpanded()).toBe(false);
    expect(bridge.ui.getAllThemes()).toEqual([]);
    expect(bridge.ui.getTheme("dark")).toBeUndefined();
    expect(bridge.ui.setTheme("dark").success).toBe(false);
    expect(bridge.ui.onTerminalInput(() => undefined)).toBeTypeOf("function");
    expect(bridge.sent).toHaveLength(0);
  });

  it("refuses a dialog whose broadcast throws", async () => {
    const bridge = createWebSocketUIContext({
      lane: "main",
      broadcast: () => {
        throw new Error("socket gone");
      },
      timeoutMs: 10_000
    });
    await expect(bridge.ui.confirm("Sure?", "really")).rejects.toBeInstanceOf(
      NoExtensionUiError
    );
    expect(bridge.pending()).toBe(0);
  });
});
