import { describe, expect, it } from "vitest";
import { SessionEventProjector } from "../events";
import type {
  OpenCodeEvent,
  OpenCodeMessage,
  OpenCodeSessionSnapshot
} from "../types";

const SESSION = "ses_root";

/** An OpenCode event with only the fields the projector reads. */
function event(type: string, data: Record<string, unknown>): OpenCodeEvent {
  // SAFETY: the projector reads only `type` and the `data` fields given
  // here; the rest of OpenCode's envelope (ids, timestamps, `durable`) is
  // irrelevant to it.
  return {
    id: "evt",
    created: 0,
    type,
    data: { sessionID: SESSION, ...data }
  } as unknown as OpenCodeEvent;
}

function snapshot(
  overrides: Partial<OpenCodeSessionSnapshot> = {}
): OpenCodeSessionSnapshot {
  return {
    session: SESSION,
    messages: [],
    pending: [],
    busy: false,
    permissions: [],
    ...overrides
  };
}

const MODEL = { providerID: "cloudflare", id: "model" };

/** One run that answers `operationId` with `text`. */
function run(operationId: string, text: string, message: string) {
  return [
    event("session.execution.started", {}),
    event("session.inbox.delivered", { inboxID: `msg_${operationId}` }),
    event("session.step.started", {
      assistantMessageID: message,
      agent: "build",
      model: MODEL
    }),
    event("session.text.ended", {
      assistantMessageID: message,
      ordinal: 0,
      text
    }),
    event("session.step.ended", {
      assistantMessageID: message,
      finish: "stop"
    }),
    event("session.execution.succeeded", {})
  ];
}

function ends(
  projector: SessionEventProjector,
  events: readonly OpenCodeEvent[]
) {
  return events
    .flatMap((raw) => projector.project(raw))
    .flatMap((projected) =>
      projected.type === "operation_end" ? [projected.result] : []
    );
}

describe("SessionEventProjector", () => {
  it("ends an input once when its delivery repeats the snapshot", () => {
    // The snapshot was read after `op-1` was delivered, and the stream also
    // buffered the delivery.
    const assistant = {
      type: "assistant",
      id: "msg_a",
      content: [{ type: "text", text: "partial" }]
    } as unknown as OpenCodeMessage;
    const projector = new SessionEventProjector(
      snapshot({
        busy: true,
        messages: [assistant],
        pending: [{ operationId: "op-1", session: SESSION, status: "running" }]
      })
    );
    const results = ends(projector, [
      event("session.inbox.delivered", { inboxID: "msg_op-1" }),
      event("session.text.ended", {
        assistantMessageID: "msg_a",
        ordinal: 0,
        text: "done"
      }),
      event("session.execution.succeeded", {})
    ]);
    expect(results).toEqual([
      { operationId: "op-1", session: SESSION, status: "done", text: "done" }
    ]);
  });

  it("does not start or end an input again after it ended", () => {
    const projector = new SessionEventProjector(snapshot());
    const events = run("op-1", "one", "msg_a");
    const first = events.flatMap((raw) => projector.project(raw));
    expect(
      first.filter((projected) => projected.type === "operation_end")
    ).toHaveLength(1);
    // The same delivery again, as a stream that overlapped the snapshot
    // might see it.
    expect(
      projector.project(
        event("session.inbox.delivered", { inboxID: "msg_op-1" })
      )
    ).toEqual([]);
  });

  it("gives a run with no assistant message no text from the run before", () => {
    const projector = new SessionEventProjector(snapshot());
    expect(ends(projector, run("op-1", "hello", "msg_a"))).toEqual([
      { operationId: "op-1", session: SESSION, status: "done", text: "hello" }
    ]);
    expect(
      ends(projector, [
        event("session.execution.started", {}),
        event("session.inbox.delivered", { inboxID: "msg_op-2" }),
        event("session.execution.succeeded", {})
      ])
    ).toEqual([
      { operationId: "op-2", session: SESSION, status: "done", text: "" }
    ]);
  });

  it("ends a follow-up drained into the same run with its own answer", () => {
    const projector = new SessionEventProjector(snapshot());
    const results = ends(projector, [
      ...run("op-1", "one", "msg_a").slice(0, -1),
      event("session.inbox.delivered", { inboxID: "msg_op-2" }),
      event("session.step.started", {
        assistantMessageID: "msg_b",
        agent: "build",
        model: MODEL
      }),
      event("session.text.ended", {
        assistantMessageID: "msg_b",
        ordinal: 0,
        text: "two"
      }),
      event("session.execution.succeeded", {})
    ]);
    expect(results.map((result) => [result.operationId, result.text])).toEqual([
      ["op-1", "one"],
      ["op-2", "two"]
    ]);
  });

  it("names a tool from its input event", () => {
    const projector = new SessionEventProjector(snapshot());
    projector.project(
      event("session.tool.input.started", {
        assistantMessageID: "msg_a",
        id: "call_1",
        name: "shout"
      })
    );
    expect(
      projector.project(
        event("session.tool.called", {
          assistantMessageID: "msg_a",
          id: "call_1",
          input: { text: "hi" },
          executed: true
        })
      )
    ).toEqual([
      {
        type: "tool_start",
        messageId: "msg_a",
        toolCallId: "call_1",
        name: "shout",
        input: { text: "hi" }
      }
    ]);
  });
});
