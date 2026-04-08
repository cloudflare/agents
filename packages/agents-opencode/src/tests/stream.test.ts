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

  it("interleaves text and tool parts chronologically", () => {
    const acc = makeAccumulator();

    // Step 1: initial reasoning text
    acc.processEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "text",
          text: "Scaffolding the app",
          sessionID: SESSION_ID
        }
      }
    });

    // Step 1: tool call after the text
    acc.processEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          tool: "bash",
          callID: "call-scaffold",
          sessionID: SESSION_ID,
          state: {
            status: "completed",
            input: { command: "npm create vite" },
            output: "Done",
            title: "Scaffold"
          }
        }
      }
    });

    // Step 2: new reasoning text (should appear AFTER the tool, not replace step 1)
    acc.processEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "text",
          text: "Installing dependencies",
          sessionID: SESSION_ID
        }
      }
    });

    // Step 2: another tool call
    acc.processEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          tool: "bash",
          callID: "call-install",
          sessionID: SESSION_ID,
          state: {
            status: "completed",
            input: { command: "npm install" },
            output: "Done",
            title: "Install"
          }
        }
      }
    });

    // Step 3: final text
    acc.processEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "text",
          text: "All done",
          sessionID: SESSION_ID
        }
      }
    });

    const snap = acc.getSnapshot();
    const parts = snap.messages[0].parts;

    // Should be: text, tool, text, tool, text — interleaved chronologically
    expect(parts).toHaveLength(5);
    expect(parts[0].type).toBe("text");
    assert(parts[0].type === "text");
    expect(parts[0].text).toBe("Scaffolding the app");

    expect(parts[1].type).toBe("dynamic-tool");

    expect(parts[2].type).toBe("text");
    assert(parts[2].type === "text");
    expect(parts[2].text).toBe("Installing dependencies");

    expect(parts[3].type).toBe("dynamic-tool");

    expect(parts[4].type).toBe("text");
    assert(parts[4].type === "text");
    expect(parts[4].text).toBe("All done");
  });

  it("overwrites text in place when no tool parts intervene", () => {
    const acc = makeAccumulator();

    // Streaming text within a single step: should overwrite, not append
    acc.processEvent({
      type: "message.part.updated",
      properties: {
        part: { type: "text", text: "Thinking...", sessionID: SESSION_ID }
      }
    });
    acc.processEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "text",
          text: "Thinking... about the problem",
          sessionID: SESSION_ID
        }
      }
    });

    const snap = acc.getSnapshot();
    const textParts = snap.messages[0].parts.filter((p) => p.type === "text");
    // Only one text part — the second update overwrote the first
    expect(textParts).toHaveLength(1);
    assert(textParts[0].type === "text");
    expect(textParts[0].text).toBe("Thinking... about the problem");
  });

  it("interleaves deltas with tool parts", () => {
    const acc = makeAccumulator();

    // Delta text before any tools
    acc.processEvent({
      type: "message.part.delta",
      properties: { sessionID: SESSION_ID, field: "text", delta: "Step 1" }
    });

    // Tool call
    acc.processEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          tool: "read",
          callID: "call-read",
          sessionID: SESSION_ID,
          state: {
            status: "completed",
            input: { path: "/foo" },
            output: "contents",
            title: "Read foo"
          }
        }
      }
    });

    // Delta text after the tool — should start a new text part
    acc.processEvent({
      type: "message.part.delta",
      properties: { sessionID: SESSION_ID, field: "text", delta: "Step 2" }
    });

    const snap = acc.getSnapshot();
    const parts = snap.messages[0].parts;

    expect(parts).toHaveLength(3);
    expect(parts[0].type).toBe("text");
    assert(parts[0].type === "text");
    expect(parts[0].text).toBe("Step 1");

    expect(parts[1].type).toBe("dynamic-tool");

    expect(parts[2].type).toBe("text");
    assert(parts[2].type === "text");
    expect(parts[2].text).toBe("Step 2");
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
          callID: "call-1",
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
          callID: "call-1",
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
          callID: "call-2",
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
          callID: "call-2",
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

  it("does not duplicate parts when the same callID is received multiple times", () => {
    const acc = makeAccumulator();

    // First pending event creates the part
    acc.processEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          tool: "bash",
          callID: "call-dup",
          sessionID: SESSION_ID,
          state: { status: "pending", input: { command: "npm install" } }
        }
      }
    });

    // Second running event for the same callID should NOT create a new part
    acc.processEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          tool: "bash",
          callID: "call-dup",
          sessionID: SESSION_ID,
          state: { status: "running", input: { command: "npm install" } }
        }
      }
    });

    // Third running event — still the same invocation
    acc.processEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          tool: "bash",
          callID: "call-dup",
          sessionID: SESSION_ID,
          state: { status: "running", input: { command: "npm install" } }
        }
      }
    });

    const snap = acc.getSnapshot();
    // Only ONE dynamic-tool part should exist, not three
    const toolParts = snap.messages[0].parts.filter(
      (p) => p.type === "dynamic-tool"
    );
    expect(toolParts).toHaveLength(1);
  });

  it("handles sequential tool calls with different callIDs after completion", () => {
    const acc = makeAccumulator();

    // First bash call: pending → completed
    acc.processEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          tool: "bash",
          callID: "call-a",
          sessionID: SESSION_ID,
          state: { status: "pending", input: { command: "ls" } }
        }
      }
    });
    acc.processEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          tool: "bash",
          callID: "call-a",
          sessionID: SESSION_ID,
          state: {
            status: "completed",
            input: { command: "ls" },
            output: "file1.ts\nfile2.ts",
            title: "List files"
          }
        }
      }
    });

    // Second bash call with a different callID: pending → running
    acc.processEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          tool: "bash",
          callID: "call-b",
          sessionID: SESSION_ID,
          state: { status: "pending", input: { command: "npm install" } }
        }
      }
    });
    acc.processEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          tool: "bash",
          callID: "call-b",
          sessionID: SESSION_ID,
          state: { status: "running", input: { command: "npm install" } }
        }
      }
    });

    const snap = acc.getSnapshot();
    const toolParts = snap.messages[0].parts.filter(
      (p) => p.type === "dynamic-tool"
    ) as Array<Record<string, unknown>>;

    // Exactly two tool parts: first completed, second still running
    expect(toolParts).toHaveLength(2);
    expect(toolParts[0].state).toBe("output-available");
    expect(toolParts[1].state).toBe("input-available");
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
