import { describe, it, expect, assert } from "vitest";
import { OpenCodeStreamAccumulator } from "../stream";

const SESSION_ID = "test-session-001";

function makeAccumulator() {
  return new OpenCodeStreamAccumulator(SESSION_ID);
}

describe("OpenCodeStreamAccumulator — text", () => {
  it("handles message.part.updated with text type", () => {
    const acc = makeAccumulator();
    acc.processEvent({
      type: "message.part.updated",
      properties: {
        part: { type: "text", text: "Hello world", sessionID: SESSION_ID }
      }
    });

    const snap = acc.getSnapshot();
    expect(snap.status).toBe("working");
    expect(snap.messages).toHaveLength(1);
    expect(snap.messages[0].role).toBe("assistant");
    const textPart = snap.messages[0].parts.find((p) => p.type === "text");
    assert(textPart?.type === "text", "expected text part");
    expect(textPart.text).toBe("Hello world");
  });

  it("handles message.part.delta for incremental text", () => {
    const acc = makeAccumulator();
    acc.processEvent({
      type: "message.part.delta",
      properties: { sessionID: SESSION_ID, field: "text", delta: "Hello" }
    });
    acc.processEvent({
      type: "message.part.delta",
      properties: { sessionID: SESSION_ID, field: "text", delta: " world" }
    });

    const snap = acc.getSnapshot();
    const textPart = snap.messages[0].parts.find((p) => p.type === "text");
    assert(textPart?.type === "text", "expected text part");
    expect(textPart.text).toBe("Hello world");
  });

  it("overwrites text on full message.part.updated", () => {
    const acc = makeAccumulator();
    acc.processEvent({
      type: "message.part.delta",
      properties: { sessionID: SESSION_ID, field: "text", delta: "old" }
    });
    acc.processEvent({
      type: "message.part.updated",
      properties: {
        part: { type: "text", text: "new text", sessionID: SESSION_ID }
      }
    });

    const snap = acc.getSnapshot();
    const textPart = snap.messages[0].parts.find((p) => p.type === "text");
    assert(textPart?.type === "text", "expected text part");
    expect(textPart.text).toBe("new text");
  });
});

describe("OpenCodeStreamAccumulator — tools", () => {
  it("tracks tool pending → completed lifecycle", () => {
    const acc = makeAccumulator();

    acc.processEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          tool: "file_edit",
          sessionID: SESSION_ID,
          state: { status: "pending", input: { path: "/foo.ts" } }
        }
      }
    });

    let snap = acc.getSnapshot();
    const parts = snap.messages[0].parts;
    expect(parts).toHaveLength(1);
    const toolPart = parts[0] as Record<string, unknown>;
    expect(toolPart.type).toBe("dynamic-tool");
    expect(toolPart.state).toBe("input-available");

    acc.processEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          tool: "file_edit",
          sessionID: SESSION_ID,
          state: {
            status: "completed",
            input: { path: "/foo.ts" },
            output: "File edited",
            title: "Edit foo.ts"
          }
        }
      }
    });

    snap = acc.getSnapshot();
    const updated = snap.messages[0].parts[0] as Record<string, unknown>;
    expect(updated.state).toBe("output-available");
    expect(updated.output).toBe("File edited");
  });

  it("tracks tool error state", () => {
    const acc = makeAccumulator();

    acc.processEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          tool: "shell",
          sessionID: SESSION_ID,
          state: { status: "running", input: { cmd: "ls" } }
        }
      }
    });

    acc.processEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          tool: "shell",
          sessionID: SESSION_ID,
          state: {
            status: "error",
            input: { cmd: "ls" },
            error: "Command failed"
          }
        }
      }
    });

    const snap = acc.getSnapshot();
    const toolPart = snap.messages[0].parts[0] as Record<string, unknown>;
    expect(toolPart.state).toBe("output-error");
    expect(toolPart.errorText).toBe("Command failed");
  });
});

describe("OpenCodeStreamAccumulator — session lifecycle", () => {
  it("session.idle sets status to complete", () => {
    const acc = makeAccumulator();
    acc.processEvent({
      type: "session.idle",
      properties: { sessionID: SESSION_ID }
    });

    const snap = acc.getSnapshot();
    expect(snap.status).toBe("complete");
    expect(snap.summary).toBe("Coding task completed.");
  });

  it("session.idle with text sets summary from response text", () => {
    const acc = makeAccumulator();
    acc.processEvent({
      type: "message.part.updated",
      properties: {
        part: { type: "text", text: "Done building app", sessionID: SESSION_ID }
      }
    });
    acc.processEvent({
      type: "session.idle",
      properties: { sessionID: SESSION_ID }
    });

    const snap = acc.getSnapshot();
    expect(snap.status).toBe("complete");
    expect(snap.summary).toBe("Done building app");
  });

  it("session.error sets status to error", () => {
    const acc = makeAccumulator();
    acc.processEvent({
      type: "session.error",
      properties: {
        sessionID: SESSION_ID,
        error: {
          name: "ApiError",
          data: { message: "Rate limited" }
        }
      }
    });

    const snap = acc.getSnapshot();
    expect(snap.status).toBe("error");
    expect(snap.error).toContain("ApiError");
    expect(snap.error).toContain("Rate limited");
  });

  it("session.status idle sets status to complete", () => {
    const acc = makeAccumulator();
    acc.processEvent({
      type: "session.status",
      properties: {
        sessionID: SESSION_ID,
        status: { type: "idle" }
      }
    });

    expect(acc.getSnapshot().status).toBe("complete");
  });

  it("session.status retry appends retry message", () => {
    const acc = makeAccumulator();
    acc.processEvent({
      type: "session.status",
      properties: {
        sessionID: SESSION_ID,
        status: { type: "retry", attempt: 2, message: "Transient error" }
      }
    });

    const snap = acc.getSnapshot();
    expect(snap.status).toBe("working");
    const textPart = snap.messages[0].parts.find((p) => p.type === "text");
    assert(textPart?.type === "text", "expected text part");
    expect(textPart.text).toContain("Retrying");
  });
});

describe("OpenCodeStreamAccumulator — file tracking", () => {
  it("file.edited tracks edited files (deduped)", () => {
    const acc = makeAccumulator();
    acc.processEvent({
      type: "file.edited",
      properties: { file: "/workspace/foo.ts" }
    });
    acc.processEvent({
      type: "file.edited",
      properties: { file: "/workspace/foo.ts" }
    });
    acc.processEvent({
      type: "file.edited",
      properties: { file: "/workspace/bar.ts" }
    });

    const snap = acc.getSnapshot();
    expect(snap.filesEdited).toEqual([
      "/workspace/foo.ts",
      "/workspace/bar.ts"
    ]);
  });

  it("file.watcher.updated tracks file changes", () => {
    const acc = makeAccumulator();
    acc.processEvent({
      type: "file.watcher.updated",
      properties: { file: "/workspace/out.js", event: "change" }
    });

    const snap = acc.getSnapshot();
    expect(snap.fileChanges).toHaveLength(1);
    expect(snap.fileChanges[0]).toEqual({
      file: "/workspace/out.js",
      event: "change"
    });
  });

  it("session.diff stores file diffs", () => {
    const acc = makeAccumulator();
    const diffs = [{ path: "foo.ts", additions: 5, deletions: 2 }];
    acc.processEvent({
      type: "session.diff",
      properties: { diff: diffs }
    });

    const snap = acc.getSnapshot();
    expect(snap.diffs).toEqual(diffs);
  });
});

describe("OpenCodeStreamAccumulator — process tracking", () => {
  it("tracks pty lifecycle: created → updated → exited → deleted", () => {
    const acc = makeAccumulator();

    acc.processEvent({
      type: "pty.created",
      properties: {
        info: {
          id: "pty-1",
          command: "npm",
          args: ["install"],
          status: "running"
        }
      }
    });

    let snap = acc.getSnapshot();
    expect(snap.processes).toHaveLength(1);
    expect(snap.processes[0].command).toBe("npm");
    expect(snap.processes[0].status).toBe("running");

    acc.processEvent({
      type: "pty.updated",
      properties: {
        info: {
          id: "pty-1",
          command: "npm",
          args: ["install"],
          status: "running"
        }
      }
    });

    acc.processEvent({
      type: "pty.exited",
      properties: { id: "pty-1", exitCode: 0 }
    });

    snap = acc.getSnapshot();
    expect(snap.processes[0].status).toBe("exited");
    expect(snap.processes[0].exitCode).toBe(0);

    acc.processEvent({
      type: "pty.deleted",
      properties: { id: "pty-1" }
    });

    snap = acc.getSnapshot();
    expect(snap.processes).toHaveLength(0);
  });
});

describe("OpenCodeStreamAccumulator — diagnostics and todos", () => {
  it("lsp.client.diagnostics tracks diagnostics", () => {
    const acc = makeAccumulator();
    acc.processEvent({
      type: "lsp.client.diagnostics",
      properties: { serverID: "ts", path: "/workspace/foo.ts" }
    });

    const snap = acc.getSnapshot();
    expect(snap.diagnostics).toHaveLength(1);
    expect(snap.diagnostics[0]).toEqual({
      serverID: "ts",
      path: "/workspace/foo.ts"
    });
  });

  it("todo.updated replaces the todo list", () => {
    const acc = makeAccumulator();
    const todos = [{ id: "1", content: "Fix bug", status: "pending" }];
    acc.processEvent({
      type: "todo.updated",
      properties: { todos }
    });

    expect(acc.getSnapshot().todos).toEqual(todos);

    const updated = [{ id: "1", content: "Fix bug", status: "done" }];
    acc.processEvent({
      type: "todo.updated",
      properties: { todos: updated }
    });

    expect(acc.getSnapshot().todos).toEqual(updated);
  });
});

describe("OpenCodeStreamAccumulator — permission/question", () => {
  it("permission.asked sets error status", () => {
    const acc = makeAccumulator();
    acc.processEvent({
      type: "permission.asked",
      properties: {
        permission: "file_write",
        metadata: { path: "/etc/passwd" }
      }
    });

    const snap = acc.getSnapshot();
    expect(snap.status).toBe("error");
    expect(snap.error).toContain("Permission requested");
  });

  it("question.asked sets error status", () => {
    const acc = makeAccumulator();
    acc.processEvent({
      type: "question.asked",
      properties: { questions: [{ question: "Which database?" }] }
    });

    const snap = acc.getSnapshot();
    expect(snap.status).toBe("error");
    expect(snap.error).toContain("Which database?");
  });
});

describe("OpenCodeStreamAccumulator — removal", () => {
  it("message.removed prunes a message", () => {
    const acc = makeAccumulator();
    acc.processEvent({
      type: "message.part.updated",
      properties: {
        part: { type: "text", text: "Hello", sessionID: SESSION_ID }
      }
    });

    const msgId = acc.getSnapshot().messages[0].id;

    acc.processEvent({
      type: "message.removed",
      properties: { sessionID: SESSION_ID, messageID: msgId }
    });

    expect(acc.getSnapshot().messages).toHaveLength(0);
  });
});

describe("OpenCodeStreamAccumulator — session filtering", () => {
  it("ignores events for a different session ID", () => {
    const acc = makeAccumulator();
    const changed = acc.processEvent({
      type: "session.idle",
      properties: { sessionID: "other-session" }
    });

    expect(changed).toBe(false);
    expect(acc.getSnapshot().status).toBe("working");
  });

  it("ignores message.part.updated for a different session", () => {
    const acc = makeAccumulator();
    const changed = acc.processEvent({
      type: "message.part.updated",
      properties: {
        part: { type: "text", text: "wrong session", sessionID: "other" }
      }
    });

    expect(changed).toBe(false);
    expect(acc.getSnapshot().messages).toHaveLength(0);
  });
});

describe("OpenCodeStreamAccumulator — dirty flag", () => {
  it("starts clean, becomes dirty after event, resets after getSnapshot", () => {
    const acc = makeAccumulator();
    expect(acc.dirty).toBe(false);

    acc.processEvent({
      type: "file.edited",
      properties: { file: "/workspace/x.ts" }
    });
    expect(acc.dirty).toBe(true);

    acc.getSnapshot();
    expect(acc.dirty).toBe(false);
  });

  it("unknown events do not set dirty", () => {
    const acc = makeAccumulator();
    acc.processEvent({ type: "tui.something", properties: {} });
    expect(acc.dirty).toBe(false);
  });
});

describe("OpenCodeStreamAccumulator — snapshot immutability", () => {
  it("getSnapshot returns deep copies", () => {
    const acc = makeAccumulator();
    acc.processEvent({
      type: "file.edited",
      properties: { file: "/workspace/a.ts" }
    });

    const snap1 = acc.getSnapshot();
    snap1.filesEdited.push("/workspace/mutated.ts");

    acc.processEvent({
      type: "file.edited",
      properties: { file: "/workspace/b.ts" }
    });

    const snap2 = acc.getSnapshot();
    expect(snap2.filesEdited).toEqual(["/workspace/a.ts", "/workspace/b.ts"]);
    expect(snap2.filesEdited).not.toContain("/workspace/mutated.ts");
  });
});

describe("OpenCodeStreamAccumulator — model tracking", () => {
  it("extracts modelID from message.updated", () => {
    const acc = makeAccumulator();
    acc.processEvent({
      type: "message.updated",
      properties: {
        info: { role: "assistant", modelID: "anthropic/claude-sonnet-4" }
      }
    });

    const snap = acc.getSnapshot();
    expect(snap.modelID).toBe("anthropic/claude-sonnet-4");
  });
});

describe("OpenCodeStreamAccumulator — unknown events", () => {
  it("silently ignores unknown event types", () => {
    const acc = makeAccumulator();
    const changed = acc.processEvent({
      type: "workspace.something",
      properties: {}
    });
    expect(changed).toBe(false);
    expect(acc.getSnapshot().messages).toHaveLength(0);
  });
});
