import { CHAT_REQUEST_CONTEXT_KEY } from "../../chat";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Connection } from "agents";
import type { ChatTurnHostObject } from "../capabilities/chat-turn";
import {
  type ChatLane,
  answerTool,
  cancelTurn,
  chatDispatch,
  clearChat,
  replayTurn,
  resumeChat,
  submitTurn
} from "../../chat/chat-functions";
import {
  type ChatHooks,
  chatTurnDefinition,
  chatTurnStreamId,
  parkedIn
} from "../../chat/chat-host";
import { TaskSettlement } from "../../tasks/settlement";

const tab = { id: "tab-1", send: () => {} } as unknown as Connection;

function chatRequest(id: string, text: string) {
  return JSON.stringify({
    type: "cf_agent_use_chat_request",
    id,
    init: {
      method: "POST",
      body: JSON.stringify({
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text }] }],
        model: "m"
      })
    }
  });
}

function chatRequestWith(id: string, messageId: string, text: string) {
  return JSON.stringify({
    type: "cf_agent_use_chat_request",
    id,
    init: {
      method: "POST",
      body: JSON.stringify({
        messages: [
          { id: messageId, role: "user", parts: [{ type: "text", text }] }
        ]
      })
    }
  });
}

describe("chat functions over a minimal host", () => {
  it("a chat request frame stores the question and runs a turn that stores the reply", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const done = instance.nextResult();
      expect(
        await chatDispatch(
          instance.deps,
          instance.lane,
          tab,
          chatRequest("r1", "Hi")
        )
      ).toBe(true);
      expect(await done).toMatchObject({
        requestId: "r1",
        status: "completed"
      });
      expect(instance.calls[0]).toMatchObject({
        trigger: "submit-message",
        questionId: "u1",
        body: { model: "m" }
      });
      const history = await instance.sessions.session("s1").getHistory();
      expect(history.map((m) => m.role)).toEqual(["user", "assistant"]);
    });
  });

  it("a clear frame empties the transcript", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const done = instance.nextResult();
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        chatRequest("r1", "Hi")
      );
      await done;
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        JSON.stringify({ type: "cf_agent_chat_clear" })
      );
      expect(await instance.sessions.session("s1").getHistory()).toEqual([]);
    });
  });

  it("a tool result stores the answer and, with autoContinue, continues the reply", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const session = instance.sessions.session("s1");
      await session.appendMessage({
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "Where am I?" }]
      } as never);
      await session.appendMessage({
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-locate",
            toolCallId: "c1",
            state: "input-available",
            input: {}
          }
        ]
      } as never);
      const done = instance.nextResult();
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        JSON.stringify({
          type: "cf_agent_tool_result",
          toolCallId: "c1",
          toolName: "locate",
          output: { city: "Lisbon" },
          autoContinue: true
        })
      );
      await done;
      expect(instance.calls[0].trigger).toBe("tool-answer");
      const answered = (await session.getHistory()).find((m) => m.id === "a1");
      expect(JSON.stringify(answered)).toContain("output-available");
      expect(JSON.stringify(answered)).toContain("Lisbon");
    });
  });

  it("a resume request is offered the streaming turn, and its ack replays what it streamed", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const sent: Array<Record<string, unknown>> = [];
      const reconnected = {
        id: "tab-2",
        readyState: 1,
        send: (text: string) => sent.push(JSON.parse(text))
      } as unknown as Connection;

      // Nothing streams yet.
      await chatDispatch(
        instance.deps,
        instance.lane,
        reconnected,
        JSON.stringify({ type: "cf_agent_stream_resume_request" })
      );
      expect(sent.at(-1)).toMatchObject({
        type: "cf_agent_stream_resume_none"
      });

      // A turn streams one chunk, then waits until the test lets it end.
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let streaming!: () => void;
      const started = new Promise<void>((resolve) => (streaming = resolve));
      const respond = instance.host.respond;
      instance.host.respond = async () =>
        new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: "start", messageId: "reply-1" });
            controller.enqueue({ type: "text-start", id: "t1" });
            controller.enqueue({ type: "text-delta", id: "t1", delta: "Hel" });
            await released;
            controller.enqueue({ type: "text-end", id: "t1" });
            controller.close();
          }
        });
      // The turn has stored the delta once the hook sees it pass.
      const hooks = instance.host.hooks as {
        transformChunk?: (chunk: { type: string }) => unknown;
      };
      hooks.transformChunk = (chunk) => {
        if (chunk.type === "text-delta") streaming();
        return chunk;
      };
      const done = instance.nextResult();
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        chatRequest("r1", "Hi")
      );
      await started;

      await chatDispatch(
        instance.deps,
        instance.lane,
        reconnected,
        JSON.stringify({ type: "cf_agent_stream_resume_request" })
      );
      expect(sent.at(-1)).toMatchObject({
        type: "cf_agent_stream_resuming",
        id: "r1"
      });
      await chatDispatch(
        instance.deps,
        instance.lane,
        reconnected,
        JSON.stringify({ type: "cf_agent_stream_resume_ack", id: "r1" })
      );
      const replayed = sent.filter((frame) => frame.replay === true);
      expect(
        replayed.map((frame) => JSON.parse(frame.body as string).type)
      ).toContain("text-delta");
      release();
      await done;
      instance.host.respond = respond;
      delete hooks.transformChunk;
    });
  });

  it("a resume while a turn is accepted but not streaming keeps the tab waiting, then offers the stream", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let called!: () => void;
      const inRespond = new Promise<void>((resolve) => (called = resolve));
      const respond = instance.host.respond;
      instance.host.respond = async (call) => {
        called();
        await released;
        return respond(call);
      };
      const sent: Array<Record<string, unknown>> = [];
      const waiting = {
        id: "tab-w",
        readyState: 1,
        send: (text: string) => sent.push(JSON.parse(text))
      } as unknown as Connection;
      const done = instance.nextResult();
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        chatRequest("r1", "Hi")
      );
      await inRespond;
      await chatDispatch(
        instance.deps,
        instance.lane,
        waiting,
        JSON.stringify({ type: "cf_agent_stream_resume_request" })
      );
      expect(sent[0]).toMatchObject({
        type: "cf_agent_stream_pending",
        id: "r1"
      });
      release();
      await done;
      expect(sent[1]).toMatchObject({
        type: "cf_agent_stream_resuming",
        id: "r1"
      });
      instance.host.respond = respond;
    });
  });

  it("a chat request without messages ends at once with the reason", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const sent: Array<Record<string, unknown>> = [];
      await chatDispatch(
        instance.deps,
        instance.lane,
        {
          id: "tab-e",
          readyState: 1,
          send: (text: string) => sent.push(JSON.parse(text))
        } as unknown as Connection,
        JSON.stringify({
          type: "cf_agent_use_chat_request",
          id: "bad",
          init: { method: "POST", body: JSON.stringify({ model: "m" }) }
        })
      );
      expect(sent[0]).toMatchObject({ id: "bad", done: true, error: true });
      expect(instance.calls).toEqual([]);
    });
  });

  function recordingTab(id: string, sent: Array<Record<string, unknown>>) {
    return {
      id,
      readyState: 1,
      send: (text: string) => sent.push(JSON.parse(text))
    } as unknown as Connection;
  }

  it("a parked tab gets its probe id back when it is offered the stream", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let called!: () => void;
      const inRespond = new Promise<void>((resolve) => (called = resolve));
      const respond = instance.host.respond;
      instance.host.respond = async (call) => {
        called();
        await released;
        return respond(call);
      };
      const sent: Array<Record<string, unknown>> = [];
      const done = instance.nextResult();
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        chatRequest("r1", "Hi")
      );
      await inRespond;
      await chatDispatch(
        instance.deps,
        instance.lane,
        recordingTab("tab-p", sent),
        JSON.stringify({
          type: "cf_agent_stream_resume_request",
          probeId: "p1"
        })
      );
      release();
      await done;
      expect(sent[0]).toMatchObject({
        type: "cf_agent_stream_pending",
        probeId: "p1"
      });
      expect(sent[1]).toMatchObject({
        type: "cf_agent_stream_resuming",
        id: "r1",
        probeId: "p1"
      });
      instance.host.respond = respond;
    });
  });

  it("a tab parked on a tool answer that starts no turn is told there is nothing to resume", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const session = instance.sessions.session("s1");
      await session.appendMessage({
        id: "u1",
        role: "user",
        parts: []
      } as never);
      await session.appendMessage({
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-ask",
            toolCallId: "c1",
            state: "input-available",
            input: {}
          }
        ]
      } as never);
      // The answer's apply waits until the tab has asked to resume.
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      const sessionOf = instance.sessions.session.bind(instance.sessions);
      (instance.sessions as { session: typeof sessionOf }).session = (id) => {
        const handle = sessionOf(id);
        const leaf = handle.getLatestLeaf.bind(handle);
        handle.getLatestLeaf = async () => {
          await released;
          return leaf();
        };
        return handle;
      };
      const sent: Array<Record<string, unknown>> = [];
      // The tab that answers is the one that asks to resume.
      const answering = recordingTab("tab-a", sent);
      const answered = answerTool(instance.deps, instance.lane, {
        kind: "result",
        toolCallId: "c1",
        output: { ok: true }
      });
      await resumeChat(instance.deps, instance.lane, answering, "p2");
      expect(sent).toEqual([
        { type: "cf_agent_stream_pending", probeId: "p2" }
      ]);
      release();
      await answered;
      expect(sent[1]).toEqual({
        type: "cf_agent_stream_resume_none",
        probeId: "p2"
      });
      expect(parkedIn(instance.streams, "s1").size).toBe(0);
    });
  });

  it("a tab whose socket closed while parked is dropped when another parks", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let called!: () => void;
      const inRespond = new Promise<void>((resolve) => (called = resolve));
      const respond = instance.host.respond;
      instance.host.respond = async (call) => {
        called();
        await released;
        return respond(call);
      };
      const done = instance.nextResult();
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        chatRequest("r1", "Hi")
      );
      await inRespond;
      const closing = { id: "tab-c", readyState: 1, send: () => {} };
      await resumeChat(instance.deps, instance.lane, closing as never);
      closing.readyState = 3;
      await resumeChat(instance.deps, instance.lane, recordingTab("tab-d", []));
      expect([...parkedIn(instance.streams, "s1").keys()]).toEqual(["tab-d"]);
      release();
      await done;
      instance.host.respond = respond;
    });
  });

  it("a tool result that arrives while the reply streams joins it, and continues after it", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let asked!: () => void;
      const toolAsked = new Promise<void>((resolve) => (asked = resolve));
      const respond = instance.host.respond;
      let first = true;
      instance.host.respond = async (call) => {
        if (!first) return respond(call);
        first = false;
        return new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: "start", messageId: "a1" });
            controller.enqueue({
              type: "tool-input-available",
              toolCallId: "c1",
              toolName: "locate",
              input: {}
            });
            await released;
            controller.close();
          }
        });
      };
      const hooks = instance.host.hooks as {
        transformChunk?: (chunk: { type: string }) => unknown;
      };
      hooks.transformChunk = (chunk) => {
        if (chunk.type === "tool-input-available") asked();
        return chunk;
      };
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        chatRequest("r1", "Where?")
      );
      await toolAsked;
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        JSON.stringify({
          type: "cf_agent_tool_result",
          toolCallId: "c1",
          toolName: "locate",
          output: { city: "Lisbon" },
          autoContinue: true
        })
      );
      release();
      await instance.resultFor("r1");
      // The continuation ran after the reply, in lane order.
      while (instance.results.length < 2) await instance.nextResult();
      const continued = instance.calls[0];
      expect(continued?.trigger).toBe("tool-answer");
      const reply = JSON.stringify(
        (await instance.sessions.session("s1").getHistory()).find(
          (m) => m.id === "a1"
        )
      );
      expect(reply).toContain("output-available");
      expect(reply).toContain("Lisbon");
      instance.host.respond = respond;
      delete hooks.transformChunk;
    });
  });

  it("a server turn runs with the tools and body of the last client request", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const first = instance.resultFor("r1");
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        JSON.stringify({
          type: "cf_agent_use_chat_request",
          id: "r1",
          init: {
            method: "POST",
            body: JSON.stringify({
              messages: [{ id: "u1", role: "user", parts: [] }],
              clientTools: [{ name: "askUser" }],
              model: "m"
            })
          }
        })
      );
      await first;
      const { requestId } = await submitTurn(instance.deps, instance.lane, {
        trigger: "server"
      });
      await instance.resultFor(requestId);
      expect(instance.calls[1]).toMatchObject({
        trigger: "server",
        clientTools: [{ name: "askUser" }],
        body: { model: "m" }
      });
    });
  });

  it("a question queued behind a reply is stored after that reply (U1 A1 U2 A2)", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      // Each reply gets its own id from its run.
      instance.reply = [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Hello" },
        { type: "text-end", id: "t1" }
      ];
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let called!: () => void;
      const inRespond = new Promise<void>((resolve) => (called = resolve));
      const respond = instance.host.respond;
      let first = true;
      instance.host.respond = async (call) => {
        if (first) {
          first = false;
          called();
          await released;
        }
        return respond(call);
      };
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        chatRequestWith("r1", "u1", "One")
      );
      await inRespond;
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        chatRequestWith("r2", "u2", "Two")
      );
      release();
      await instance.resultFor("r2");
      const ids = (await instance.sessions.session("s1").getHistory()).map(
        (m) => m.id
      );
      expect(ids).toEqual(["u1", "r1-reply", "u2", "r2-reply"]);
      instance.host.respond = respond;
    });
  });

  it("an answer to a call in an older reply is stored, and nothing continues", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const session = instance.sessions.session("s1");
      await session.appendMessage({
        id: "u1",
        role: "user",
        parts: []
      } as never);
      await session.appendMessage({
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-ask",
            toolCallId: "c1",
            state: "input-available",
            input: {}
          }
        ]
      } as never);
      await session.appendMessage({
        id: "u2",
        role: "user",
        parts: []
      } as never);
      await session.appendMessage({
        id: "a2",
        role: "assistant",
        parts: [{ type: "text", text: "Latest" }]
      } as never);
      expect(
        await answerTool(
          instance.deps,
          instance.lane,
          { kind: "result", toolCallId: "c1", output: { ok: true } },
          { autoContinue: true }
        )
      ).toBe(true);
      expect(JSON.stringify(await session.getMessage("a1"))).toContain(
        "output-available"
      );
      expect(await session.getMessage("a2")).toMatchObject({
        parts: [{ type: "text", text: "Latest" }]
      });
      expect(
        instance.tasks.peekList({
          definition: instance.lane.definition,
          lane: instance.lane.lane,
          status: ["pending", "running"],
          results: false
        })
      ).toHaveLength(0);
    });
  });
  it("a tab parked on a tool answer that starts a turn is offered that turn's stream, with its probe id", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const session = instance.sessions.session("s1");
      await session.appendMessage({
        id: "u1",
        role: "user",
        parts: []
      } as never);
      await session.appendMessage({
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-ask",
            toolCallId: "c1",
            state: "input-available",
            input: {}
          }
        ]
      } as never);
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      const sessionOf = instance.sessions.session.bind(instance.sessions);
      (instance.sessions as { session: typeof sessionOf }).session = (id) => {
        const handle = sessionOf(id);
        const leaf = handle.getLatestLeaf.bind(handle);
        handle.getLatestLeaf = async () => {
          await released;
          return leaf();
        };
        return handle;
      };
      const done = instance.nextResult();
      const sent: Array<Record<string, unknown>> = [];
      // The tab that answers is the one that asks to resume.
      const answering = recordingTab("tab-h", sent);
      const answered = answerTool(
        instance.deps,
        instance.lane,
        { kind: "result", toolCallId: "c1", output: { ok: true } },
        { autoContinue: true, connection: answering }
      );
      await resumeChat(instance.deps, instance.lane, answering, "p3");
      release();
      await answered;
      const result = await done;
      expect(sent[0]).toEqual({
        type: "cf_agent_stream_pending",
        probeId: "p3"
      });
      expect(sent[1]).toEqual({
        type: "cf_agent_stream_resuming",
        id: result.requestId,
        probeId: "p3"
      });
    });
  });

  /**
   * r1's model streams `chunks`, then waits for the returned release before
   * it ends; later calls answer with the fixture's reply. `seen` records the
   * type of every chunk the host's chunk hook is given.
   */

  async function streamThenHold(
    instance: ChatTurnHostObject,
    chunks: unknown[],
    seen: string[] = [],
    request = chatRequest("r1", "Hi")
  ) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const allSent = new Promise<void>((resolve) => (reached = resolve));
    const respond = instance.host.respond;
    let first = true;
    instance.host.respond = async (call) => {
      if (!first) return respond(call);
      first = false;
      return new ReadableStream({
        async start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk as never);
          await released;
          controller.enqueue({ type: "text-start", id: "tz" } as never);
          controller.enqueue({
            type: "text-delta",
            id: "tz",
            delta: " world"
          } as never);
          controller.enqueue({ type: "text-end", id: "tz" } as never);
          controller.close();
        }
      });
    };
    let count = 0;
    (instance.host.hooks as { transformChunk?: unknown }).transformChunk =
      (chunk: { type: string }) => {
        seen.push(chunk.type);
        if (++count === chunks.length) reached();
        return chunk;
      };
    await chatDispatch(instance.deps, instance.lane, tab, request);
    await allSent;
    return release;
  }

  function toolResult(toolCallId: string, autoContinue = true) {
    return JSON.stringify({
      type: "cf_agent_tool_result",
      toolCallId,
      toolName: "ask",
      output: { ok: toolCallId },
      autoContinue
    });
  }

  it("a reply a queued request sends back does not overwrite the finished one", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const release = await streamThenHold(instance, [
        { type: "start", messageId: "a1" },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Hello" },
        { type: "text-end", id: "t1" }
      ]);
      // The tab's list holds the reply as it had streamed so far.
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        JSON.stringify({
          type: "cf_agent_use_chat_request",
          id: "r2",
          init: {
            method: "POST",
            body: JSON.stringify({
              messages: [
                {
                  id: "u1",
                  role: "user",
                  parts: [{ type: "text", text: "Hi" }]
                },
                {
                  id: "a1",
                  role: "assistant",
                  parts: [{ type: "text", text: "Hello" }]
                },
                {
                  id: "u2",
                  role: "user",
                  parts: [{ type: "text", text: "Two" }]
                }
              ]
            })
          }
        })
      );
      release();
      await instance.resultFor("r2");
      const reply = await instance.sessions.session("s1").getMessage("a1");
      expect(JSON.stringify(reply)).toContain(" world");
    });
  });

  it("a live tool answer's continuation extends the reply that asked, not a question queued meanwhile", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const release = await streamThenHold(instance, [
        { type: "start", messageId: "a1" },
        {
          type: "tool-input-available",
          toolCallId: "c1",
          toolName: "ask",
          input: {}
        }
      ]);
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        chatRequestWith("r2", "u2", "Two")
      );
      await chatDispatch(instance.deps, instance.lane, tab, toolResult("c1"));
      release();
      while (instance.results.length < 3) await instance.nextResult();
      const continued = instance.calls.find((c) => c.trigger === "tool-answer");
      expect(continued).toMatchObject({ mode: "continue", replyId: "a1" });
    });
  });

  it("a stopped request that had not started keeps its question", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const release = await streamThenHold(instance, [
        { type: "start", messageId: "a1" }
      ]);
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        chatRequestWith("r2", "u2", "Two")
      );
      const firstContext = await instance.sessions
        .session("s1")
        .internal_config(CHAT_REQUEST_CONTEXT_KEY);
      await cancelTurn(instance.deps, "r2");
      release();
      expect(await instance.resultFor("r2")).toMatchObject({
        status: "aborted"
      });
      const ids = (await instance.sessions.session("s1").getHistory()).map(
        (m) => m.id
      );
      // In lane order: the reply it waited behind comes first.
      expect(ids).toEqual(["u1", "a1", "u2"]);
      // It never ran: the stored context is still the first request's.
      expect(
        await instance.sessions
          .session("s1")
          .internal_config(CHAT_REQUEST_CONTEXT_KEY)
      ).toBe(firstContext);
    });
  });

  it("a stopped server turn that had not started stores nothing", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const release = await streamThenHold(instance, [
        { type: "start", messageId: "a1" }
      ]);
      await submitTurn(
        instance.deps,
        instance.lane,
        {
          trigger: "server",
          messages: [
            { id: "s2", role: "user", parts: [{ type: "text", text: "Two" }] }
          ]
        },
        { requestId: "r2" }
      );
      await cancelTurn(instance.deps, "r2");
      release();
      expect(await instance.resultFor("r2")).toMatchObject({
        status: "aborted"
      });
      const ids = (await instance.sessions.session("s1").getHistory()).map(
        (m) => m.id
      );
      expect(ids).toEqual(["u1", "a1"]);
    });
  });

  it("answers to a live batch start one continuation, after the last, and pass the chunk hook", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const seen: string[] = [];
      const release = await streamThenHold(
        instance,
        [
          { type: "start", messageId: "a1" },
          {
            type: "tool-input-available",
            toolCallId: "c1",
            toolName: "ask",
            input: {}
          },
          {
            type: "tool-input-available",
            toolCallId: "c2",
            toolName: "ask",
            input: {}
          }
        ],
        seen
      );
      await chatDispatch(instance.deps, instance.lane, tab, toolResult("c1"));
      expect(
        instance.tasks.peekList({
          definition: instance.lane.definition,
          lane: instance.lane.lane,
          status: ["pending"],
          results: false
        })
      ).toHaveLength(0);
      await chatDispatch(instance.deps, instance.lane, tab, toolResult("c2"));
      release();
      while (instance.results.length < 2) await instance.nextResult();
      expect(
        instance.calls.filter((c) => c.trigger === "tool-answer")
      ).toHaveLength(1);
      expect(seen.filter((t) => t === "tool-output-available")).toHaveLength(2);
    });
  });

  it("a turn's chunks are written in batches, and a replay flushes them first", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const release = await streamThenHold(instance, [
        { type: "start", messageId: "a1" },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "a" },
        { type: "text-delta", id: "t1", delta: "b" },
        { type: "text-delta", id: "t1", delta: "c" }
      ]);
      // Five chunks streamed: they wait in the batch, not one row each.
      const stop = new AbortController();
      let written = 0;
      try {
        for await (const batch of instance.streams.readBatches(
          chatTurnStreamId("r1"),
          { signal: stop.signal, onUpToDate: () => stop.abort() }
        )) {
          written += batch.length;
          if (stop.signal.aborted) break;
        }
      } catch (error) {
        if (!stop.signal.aborted) throw error;
      }
      expect(written).toBeLessThan(5);
      const sent: Array<Record<string, unknown>> = [];
      await replayTurn(instance.deps, recordingTab("tab-r", sent), "r1");
      expect(sent).toHaveLength(5);
      release();
      await instance.resultFor("r1");
    });
  });

  it("a batch asked to continue by one answer continues when an answer that did not ask finishes it", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const release = await streamThenHold(instance, [
        { type: "start", messageId: "a1" },
        {
          type: "tool-input-available",
          toolCallId: "c1",
          toolName: "ask",
          input: {}
        },
        {
          type: "tool-input-available",
          toolCallId: "c2",
          toolName: "ask",
          input: {}
        }
      ]);
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        toolResult("c1", true)
      );
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        toolResult("c2", false)
      );
      release();
      while (instance.results.length < 2) await instance.nextResult();
      expect(
        instance.calls.filter((c) => c.trigger === "tool-answer")
      ).toHaveLength(1);
    });
  });

  it("a batch asked to continue continues when a server tool's output finishes it", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let asked!: () => void;
      const bothAsked = new Promise<void>((resolve) => (asked = resolve));
      const respond = instance.host.respond;
      let first = true;
      instance.host.respond = async (call) => {
        if (!first) return respond(call);
        first = false;
        return new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: "start", messageId: "a1" });
            controller.enqueue({
              type: "tool-input-available",
              toolCallId: "c1",
              toolName: "ask",
              input: {}
            });
            controller.enqueue({
              type: "tool-input-available",
              toolCallId: "s1",
              toolName: "lookup",
              input: {}
            });
            await released;
            // The server tool finishes after the tab answered.
            controller.enqueue({
              type: "tool-output-available",
              toolCallId: "s1",
              output: 1
            });
            controller.close();
          }
        });
      };
      let count = 0;
      (instance.host.hooks as { transformChunk?: unknown }).transformChunk =
        (chunk: { type: string }) => {
          if (chunk.type === "tool-input-available" && ++count === 2) asked();
          return chunk;
        };
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        chatRequest("r1", "Hi")
      );
      await bothAsked;
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        toolResult("c1", true)
      );
      release();
      while (instance.results.length < 2) await instance.nextResult();
      expect(
        instance.calls.filter((c) => c.trigger === "tool-answer")
      ).toHaveLength(1);
      instance.host.respond = respond;
    });
  });

  it("a tab's answer to a live call is written before it is acted on", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const release = await streamThenHold(instance, [
        { type: "start", messageId: "a1" },
        {
          type: "tool-input-available",
          toolCallId: "c1",
          toolName: "ask",
          input: {}
        }
      ]);
      await chatDispatch(instance.deps, instance.lane, tab, toolResult("c1"));
      // Read the stored chunks without flushing: a reset now keeps them.
      const stop = new AbortController();
      const types: string[] = [];
      try {
        for await (const batch of instance.streams.readBatches(
          chatTurnStreamId("r1"),
          { signal: stop.signal, onUpToDate: () => stop.abort() }
        )) {
          for (const item of batch)
            types.push((item.chunk as { type: string }).type);
          if (stop.signal.aborted) break;
        }
      } catch (error) {
        if (!stop.signal.aborted) throw error;
      }
      expect(types).toContain("tool-output-available");
      release();
      while (instance.results.length < 2) await instance.nextResult();
    });
  });

  it("of two waiting requests, a stopped later one keeps its question after the earlier one's reply", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      instance.reply = [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Hello" },
        { type: "text-end", id: "t1" }
      ];
      const release = await streamThenHold(instance, [
        { type: "start", messageId: "a1" }
      ]);
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        chatRequestWith("r2", "u2", "Two")
      );
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        chatRequestWith("r3", "u3", "Three")
      );
      await cancelTurn(instance.deps, "r3");
      // The stop is kept on the run itself, which survives a reset.
      expect(instance.tasks.peek("r3")?.metadata).toMatchObject({
        chat: { stopped: true }
      });
      release();
      expect(await instance.resultFor("r3")).toMatchObject({
        status: "aborted"
      });
      const ids = (await instance.sessions.session("s1").getHistory()).map(
        (m) => m.id
      );
      expect(ids).toEqual(["u1", "a1", "u2", "r2-reply", "u3"]);
      // r3 never called the model (r1's call is the held fake's).
      expect(instance.calls.map((c) => c.requestId)).toEqual(["r2"]);
    });
  });

  it("a denied server tool counts as answered for the batch's continuation", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let asked!: () => void;
      const bothAsked = new Promise<void>((resolve) => (asked = resolve));
      const respond = instance.host.respond;
      let first = true;
      instance.host.respond = async (call) => {
        if (!first) return respond(call);
        first = false;
        return new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: "start", messageId: "a1" });
            controller.enqueue({
              type: "tool-input-available",
              toolCallId: "c1",
              toolName: "ask",
              input: {}
            });
            controller.enqueue({
              type: "tool-input-available",
              toolCallId: "s1",
              toolName: "lookup",
              input: {}
            });
            await released;
            controller.enqueue({
              type: "tool-output-denied",
              toolCallId: "s1"
            });
            controller.close();
          }
        });
      };
      let count = 0;
      (instance.host.hooks as { transformChunk?: unknown }).transformChunk =
        (chunk: { type: string }) => {
          if (chunk.type === "tool-input-available" && ++count === 2) asked();
          return chunk;
        };
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        chatRequest("r1", "Hi")
      );
      await bothAsked;
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        toolResult("c1", true)
      );
      release();
      while (instance.results.length < 2) await instance.nextResult();
      expect(
        instance.calls.filter((c) => c.trigger === "tool-answer")
      ).toHaveLength(1);
      instance.host.respond = respond;
    });
  });

  it("a stop drops what earlier answers asked to continue", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const release = await streamThenHold(
        instance,
        [
          { type: "start", messageId: "a1" },
          {
            type: "tool-input-available",
            toolCallId: "c1",
            toolName: "ask",
            input: {}
          },
          {
            type: "tool-input-available",
            toolCallId: "c2",
            toolName: "ask",
            input: {}
          }
        ],
        [],
        JSON.stringify({
          type: "cf_agent_use_chat_request",
          id: "r1",
          init: {
            method: "POST",
            body: JSON.stringify({
              messages: [
                {
                  id: "u1",
                  role: "user",
                  parts: [{ type: "text", text: "Hi" }]
                }
              ],
              clientTools: [{ name: "ask" }]
            })
          }
        })
      );
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        toolResult("c1", true)
      );
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        JSON.stringify({ type: "cf_agent_chat_request_cancel", id: "r1" })
      );
      release();
      await instance.resultFor("r1");
      // The last answer, after the stop, asks for nothing.
      await answerTool(instance.deps, instance.lane, {
        kind: "result",
        toolCallId: "c2",
        output: { ok: "c2" }
      });
      expect(
        instance.calls.filter((c) => c.trigger === "tool-answer")
      ).toHaveLength(0);
      expect(
        instance.tasks.peekList({
          definition: instance.lane.definition,
          lane: instance.lane.lane,
          status: ["pending", "running"],
          results: false
        })
      ).toHaveLength(0);
    });
  });

  it("a queued turn stopped before a reset ends aborted when reclaimed, storing its question and calling nothing", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const release = await streamThenHold(instance, [
        { type: "start", messageId: "a1" }
      ]);
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        chatRequestWith("r2", "u2", "Two")
      );
      await cancelTurn(instance.deps, "r2");
      // After a reset, the reclaimed run's first attempt starts.
      const input = instance.tasks.inputOf("r2");
      const settled = await chatTurnDefinition(instance.deps, instance.host, {
        name: instance.lane.definition
      })(
        input as never,
        {
          id: "r2",
          attempt: 1,
          checkpoint: { get: () => undefined, set: () => {} },
          createdAt: 0,
          sleep: async () => {},
          signal: new AbortController().signal,
          local: undefined,
          interrupted: null,
          do: async (_name: string, fn: () => unknown) => fn()
        } as never
      );
      expect(settled).toBeInstanceOf(TaskSettlement);
      expect(instance.calls.map((c) => c.requestId)).not.toContain("r2");
      expect(
        await instance.sessions.session("s1").getMessage("u2")
      ).not.toBeNull();
      release();
      await instance.resultFor("r1");
    });
  });

  it("a server tool's call is written before the tool runs, so a reset while it runs keeps it", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      // The tool runs (the model stream waits) after its input arrived.
      const release = await streamThenHold(instance, [
        { type: "start", messageId: "a1" },
        { type: "tool-input-start", toolCallId: "s1", toolName: "lookup" },
        { type: "tool-input-delta", toolCallId: "s1", inputTextDelta: "{}" },
        {
          type: "tool-input-available",
          toolCallId: "s1",
          toolName: "lookup",
          input: {}
        }
      ]);
      // What a reset now would find: the stored chunks, nothing flushed.
      const stop = new AbortController();
      const types: string[] = [];
      try {
        for await (const batch of instance.streams.readBatches(
          chatTurnStreamId("r1"),
          { signal: stop.signal, onUpToDate: () => stop.abort() }
        )) {
          for (const item of batch)
            types.push((item.chunk as { type: string }).type);
          if (stop.signal.aborted) break;
        }
      } catch (error) {
        if (!stop.signal.aborted) throw error;
      }
      expect(types).toContain("tool-input-available");
      release();
      await instance.resultFor("r1");
    });
  });

  it("a finished step is written before the model is called again", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const release = await streamThenHold(instance, [
        { type: "start", messageId: "a1" },
        { type: "start-step" },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Step one" },
        { type: "text-end", id: "t1" },
        { type: "finish-step" }
      ]);
      const stop = new AbortController();
      const types: string[] = [];
      try {
        for await (const batch of instance.streams.readBatches(
          chatTurnStreamId("r1"),
          { signal: stop.signal, onUpToDate: () => stop.abort() }
        )) {
          for (const item of batch)
            types.push((item.chunk as { type: string }).type);
          if (stop.signal.aborted) break;
        }
      } catch (error) {
        if (!stop.signal.aborted) throw error;
      }
      expect(types).toContain("text-delta");
      expect(types).toContain("finish-step");
      release();
      await instance.resultFor("r1");
    });
  });

  it("under latest, a message that arrives while one waits skips the waiting turn and answers both", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      // The first turn runs until the test lets it end.
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let running!: () => void;
      const started = new Promise<void>((resolve) => (running = resolve));
      const respond = instance.host.respond;
      let first = true;
      instance.host.respond = async (call) => {
        if (first) {
          first = false;
          running();
          await released;
        }
        return respond(call);
      };
      const lane = { ...instance.lane, arrival: "latest" as const };
      const one = instance.resultFor("r1");
      await chatDispatch(instance.deps, lane, tab, chatRequest("r1", "one"));
      await started;
      await chatDispatch(
        instance.deps,
        lane,
        tab,
        chatRequestWith("r2", "u2", "two")
      );
      await chatDispatch(
        instance.deps,
        lane,
        tab,
        chatRequestWith("r3", "u3", "three")
      );
      release();
      await one;
      expect(await instance.resultFor("r3")).toMatchObject({
        status: "completed"
      });
      // r2 never called the model; r3's call saw both questions.
      expect(instance.calls.map((c) => c.requestId)).toEqual(["r1", "r3"]);
      const last = instance.calls[1].messages.map((m) => m.id);
      expect(last).toContain("u2");
      expect(last).toContain("u3");
      instance.host.respond = respond;
    });
  });

  /** Start r1 and hold it in respond until the returned release is called. */

  async function holdFirstTurn(instance: ChatTurnHostObject, lane: ChatLane) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let running!: () => void;
    const started = new Promise<void>((resolve) => (running = resolve));
    const respond = instance.host.respond;
    let first = true;
    instance.host.respond = async (call) => {
      if (first) {
        first = false;
        running();
        await released;
      }
      return respond(call);
    };
    const one = instance.resultFor("r1");
    await chatDispatch(instance.deps, lane, tab, chatRequest("r1", "one"));
    await started;
    return async () => {
      release();
      await one;
    };
  }

  function regenerateRequest(id: string) {
    return JSON.stringify({
      type: "cf_agent_use_chat_request",
      id,
      init: {
        method: "POST",
        body: JSON.stringify({
          trigger: "regenerate-message",
          messages: [
            { id: "u1", role: "user", parts: [{ type: "text", text: "one" }] }
          ]
        })
      }
    });
  }

  it("under drop, a message that arrives while a turn runs is not started, and the tab is told", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const sent: Array<Record<string, unknown>> = [];
      const other: Array<Record<string, unknown>> = [];
      const sender = recordingTab("tab-x", sent);
      const deps = {
        ...instance.deps,
        webSockets: {
          getConnections: () => [sender, recordingTab("tab-y", other)]
        } as never
      };
      const lane = { ...instance.lane, arrival: "drop" as const };
      const finish = await holdFirstTurn(instance, lane);
      await chatDispatch(
        deps,
        lane,
        sender,
        chatRequestWith("r2", "u2", "two")
      );
      await finish();
      expect(instance.calls.map((c) => c.requestId)).toEqual(["r1"]);
      expect(await instance.sessions.session("s1").getMessage("u2")).toBeNull();
      // The tab that sent it is told; another tab never saw it.
      expect(sent).toContainEqual(
        expect.objectContaining({ id: "r2", done: true, outcome: "skipped" })
      );
      expect(other.filter((frame) => frame.id === "r2")).toEqual([]);
      // It is sent the stored list back, which takes the dropped message
      // out of its own.
      const list = sent.find(
        (frame) => frame.type === "cf_agent_chat_messages"
      );
      expect(list).toBeDefined();
      expect(JSON.stringify(list)).not.toContain('"u2"');
    });
  });

  it("under merge, the queued questions are joined into one message that one turn answers", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const lane = { ...instance.lane, arrival: "merge" as const };
      const finish = await holdFirstTurn(instance, lane);
      await chatDispatch(
        instance.deps,
        lane,
        tab,
        chatRequestWith("r2", "u2", "two")
      );
      await chatDispatch(
        instance.deps,
        lane,
        tab,
        chatRequestWith("r3", "u3", "three")
      );
      await finish();
      await instance.resultFor("r3");
      expect(instance.calls.map((c) => c.requestId)).toEqual(["r1", "r3"]);
      const history = await instance.sessions.session("s1").getHistory();
      expect(history.map((m) => m.id)).not.toContain("u2");
      const merged = history.find((m) => m.id === "u3");
      expect(JSON.stringify(merged?.parts)).toContain("two\\n\\nthree");
    });
  });

  it("under debounce, a burst of messages is answered by its last turn", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const lane = { ...instance.lane, arrival: { debounceMs: 1 } };
      const finish = await holdFirstTurn(instance, lane);
      await chatDispatch(
        instance.deps,
        lane,
        tab,
        chatRequestWith("r2", "u2", "two")
      );
      await chatDispatch(
        instance.deps,
        lane,
        tab,
        chatRequestWith("r3", "u3", "three")
      );
      await finish();
      await instance.resultFor("r3");
      expect(instance.calls.map((c) => c.requestId)).toEqual(["r1", "r3"]);
      const last = instance.calls[1].messages.map((m) => m.id);
      expect(last).toContain("u2");
      expect(last).toContain("u3");
    });
  });

  it("the arrival policy applies to new messages only: a regenerate under drop still queues", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const lane = { ...instance.lane, arrival: "drop" as const };
      const finish = await holdFirstTurn(instance, lane);
      await chatDispatch(instance.deps, lane, tab, regenerateRequest("g1"));
      await finish();
      expect(await instance.resultFor("g1")).toMatchObject({
        status: "completed"
      });
      expect(instance.calls.map((c) => c.requestId)).toEqual(["r1", "g1"]);
    });
  });

  it("saveMessages and continueLastTurn are submitTurn calls", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      // saveMessages: store the messages, then a server turn answers them.
      const saved = await submitTurn(instance.deps, instance.lane, {
        trigger: "server",
        messages: [
          { id: "u1", role: "user", parts: [{ type: "text", text: "Hi" }] }
        ]
      });
      await instance.resultFor(saved.requestId);
      const replyId = instance.results[0].messageId;
      // continueLastTurn: extend the last reply.
      const continued = await submitTurn(instance.deps, instance.lane, {
        trigger: "server",
        mode: "continue"
      });
      await instance.resultFor(continued.requestId);
      expect(instance.calls[1]).toMatchObject({
        mode: "continue",
        replyId
      });
      const replies = (
        await instance.sessions.session("s1").getHistory()
      ).filter((m) => m.role === "assistant");
      expect(replies).toHaveLength(1);
    });
  });

  it("continueLastTurn with no reply to continue is skipped and calls nothing", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      await instance.sessions.session("s1").appendMessage({
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "Hi" }]
      } as never);
      const { requestId } = await submitTurn(instance.deps, instance.lane, {
        trigger: "server",
        mode: "continue"
      });
      expect(await instance.resultFor(requestId)).toMatchObject({
        status: "skipped",
        reason: "nothing-to-continue"
      });
      expect(instance.calls).toEqual([]);
    });
  });

  it("continueLastTurn while the reply waits on a client tool is skipped", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const session = instance.sessions.session("s1");
      await session.appendMessage({
        id: "u1",
        role: "user",
        parts: []
      } as never);
      await session.appendMessage({
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-ask",
            toolCallId: "c1",
            state: "input-available",
            input: {}
          }
        ]
      } as never);
      const { requestId } = await submitTurn(instance.deps, instance.lane, {
        trigger: "server",
        mode: "continue",
        clientTools: [{ name: "ask" }]
      });
      expect(await instance.resultFor(requestId)).toMatchObject({
        status: "skipped",
        reason: "awaiting-client"
      });
      expect(instance.calls).toEqual([]);
    });
  });

  it("continueLastTurn on a reply that holds nothing removes it and answers the question again", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const session = instance.sessions.session("s1");
      await session.appendMessage({
        id: "u1",
        role: "user",
        parts: []
      } as never);
      await session.appendMessage({
        id: "a1",
        role: "assistant",
        parts: [{ type: "reasoning", text: "hm" }]
      } as never);
      const { requestId } = await submitTurn(instance.deps, instance.lane, {
        trigger: "server",
        mode: "continue"
      });
      expect(await instance.resultFor(requestId)).toMatchObject({
        status: "completed"
      });
      expect(instance.calls[0]).toMatchObject({ mode: "answer" });
      expect(instance.calls[0].messages.map((m) => m.id)).toEqual(["u1"]);
      expect(await session.getMessage("a1")).toBeNull();
    });
  });

  it("a body stored with continueLastTurn is the chat's; a pinned one is that turn's only", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const session = instance.sessions.session("s1");
      await session.appendMessage({
        id: "u1",
        role: "user",
        parts: []
      } as never);
      await session.appendMessage({
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "Hi" }]
      } as never);
      const pinned = await submitTurn(instance.deps, instance.lane, {
        trigger: "server",
        mode: "continue",
        body: { pinned: true }
      });
      await instance.resultFor(pinned.requestId);
      const stored = await submitTurn(
        instance.deps,
        instance.lane,
        { trigger: "server", mode: "continue", body: { stored: true } },
        { storeContext: true }
      );
      await instance.resultFor(stored.requestId);
      const later = await submitTurn(instance.deps, instance.lane, {
        trigger: "server",
        mode: "continue"
      });
      await instance.resultFor(later.requestId);
      expect(instance.calls.map((c) => c.body)).toEqual([
        { pinned: true },
        { stored: true },
        { stored: true }
      ]);
    });
  });

  it("an abort of the signal a turn was submitted with stops it", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      let called!: () => void;
      const inRespond = new Promise<void>((resolve) => (called = resolve));
      const respond = instance.host.respond;
      instance.host.respond = async (call) => {
        called();
        await new Promise<void>((resolve) =>
          call.signal.addEventListener("abort", () => resolve(), { once: true })
        );
        return respond(call);
      };
      const stop = new AbortController();
      const { requestId } = await submitTurn(
        instance.deps,
        instance.lane,
        {
          trigger: "server",
          messages: [
            { id: "u1", role: "user", parts: [{ type: "text", text: "Hi" }] }
          ]
        },
        { signal: stop.signal }
      );
      await inRespond;
      stop.abort();
      expect(await instance.resultFor(requestId)).toMatchObject({
        status: "aborted"
      });
      instance.host.respond = respond;
    });
  });

  async function cutOffIntoBackoff(instance: ChatTurnHostObject) {
    await instance.lifecycle.start();
    // The model streams some text, then fails transiently: the turn waits
    // out its retry backoff with its stream open.
    instance.reply = [
      { type: "start", messageId: "a1" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Part" },
      { type: "error", errorText: "overloaded" }
    ];
    const hooks = instance.host.hooks;
    (instance.host as { hooks?: ChatHooks }).hooks = {
      ...hooks,
      classifyError: () => "transient"
    };
    await instance.sessions.session("s1").appendMessage({
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "Hi" }]
    } as never);
    // `start: "now"` returns after the first attempt settles.
    const { runId: requestId } = await instance.tasks.run(
      instance.lane.definition,
      { trigger: "submit-message", questionId: "u1" } as never,
      { lane: instance.lane.lane, start: "now", retain: false }
    );
    expect(instance.tasks.peek(requestId)).toMatchObject({
      status: "pending",
      waitReason: "retry"
    });
    return requestId;
  }

  it("a stop while a turn waits out its retry backoff stores what it streamed and settles its stream", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      const requestId = await cutOffIntoBackoff(instance);
      expect(await cancelTurn(instance.deps, requestId)).toBe(true);
      expect(
        (await instance.streams.status(chatTurnStreamId(requestId)))?.state
      ).not.toBe("streaming");
      const reply = await instance.sessions.session("s1").getMessage("a1");
      expect(JSON.stringify(reply)).toContain("Part");
    });
  });

  it("a clear while a turn waits out its retry backoff keeps nothing and settles its stream", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      const requestId = await cutOffIntoBackoff(instance);
      await clearChat(instance.deps, instance.lane);
      expect(
        (await instance.streams.status(chatTurnStreamId(requestId)))?.state
      ).not.toBe("streaming");
      expect(await instance.sessions.session("s1").getHistory()).toEqual([]);
    });
  });

  it("a tab that comes back after its request ended is offered it, and its ack replays how it ended", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      // r1 ends while no tab is connected.
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        chatRequest("r1", "Hi")
      );
      await instance.resultFor("r1");
      const sent: Array<Record<string, unknown>> = [];
      const back = recordingTab("tab-b", sent);
      await resumeChat(instance.deps, instance.lane, back, "p1", ["r1"]);
      expect(sent).toEqual([
        { type: "cf_agent_stream_resuming", id: "r1", probeId: "p1" }
      ]);
      await chatDispatch(
        instance.deps,
        instance.lane,
        back,
        JSON.stringify({ type: "cf_agent_stream_resume_ack", id: "r1" })
      );
      expect(sent[1]).toMatchObject({
        type: "cf_agent_use_chat_response",
        id: "r1",
        done: true,
        replay: true,
        outcome: "completed"
      });
    });
  });

  it("a tab waiting on several requests that ended is told how each ended, the newest after its ack", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        chatRequest("r1", "Hi")
      );
      await instance.resultFor("r1");
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        chatRequestWith("r2", "u2", "Again")
      );
      await instance.resultFor("r2");
      const sent: Array<Record<string, unknown>> = [];
      await resumeChat(
        instance.deps,
        instance.lane,
        recordingTab("tab-m", sent),
        undefined,
        ["r1", "r2"]
      );
      expect(sent[0]).toMatchObject({ id: "r1", done: true, replay: true });
      expect(sent[1]).toEqual({ type: "cf_agent_stream_resuming", id: "r2" });
    });
  });

  it("a chat clear forgets how earlier requests ended", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        chatRequest("r1", "Hi")
      );
      await instance.resultFor("r1");
      await clearChat(instance.deps, instance.lane);
      const sent: Array<Record<string, unknown>> = [];
      await resumeChat(
        instance.deps,
        instance.lane,
        recordingTab("tab-c", sent),
        undefined,
        ["r1"]
      );
      expect(sent).toEqual([{ type: "cf_agent_stream_resume_none" }]);
    });
  });

  it("a request dropped while no tab listened is offered to a tab that comes back for it", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const lane = { ...instance.lane, arrival: "drop" as const };
      const finish = await holdFirstTurn(instance, lane);
      await chatDispatch(
        instance.deps,
        lane,
        tab,
        chatRequestWith("r2", "u2", "two")
      );
      await finish();
      const sent: Array<Record<string, unknown>> = [];
      const back = recordingTab("tab-d2", sent);
      await resumeChat(instance.deps, instance.lane, back, undefined, ["r2"]);
      expect(sent[0]).toEqual({ type: "cf_agent_stream_resuming", id: "r2" });
      await replayTurn(instance.deps, back, "r2");
      expect(sent[1]).toMatchObject({
        id: "r2",
        done: true,
        outcome: "skipped"
      });
    });
  });

  it("a programmatic turn runs under the id it is given, retained, with its metadata and checkpoint", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const respond = instance.host.respond;
      let progress: unknown;
      instance.host.respond = async (call) => {
        // A tool reports progress through the run's checkpoint; a reader
        // outside the run sees it while the run is live.
        call.checkpoint.set("agentTool:progress", { done: 1 });
        progress = instance.tasks.checkpointOf(
          call.requestId,
          "agentTool:progress"
        );
        return respond(call);
      };
      const { requestId } = await submitTurn(
        instance.deps,
        instance.lane,
        {
          trigger: "server",
          messages: [
            { id: "u1", role: "user", parts: [{ type: "text", text: "Go" }] }
          ]
        },
        {
          requestId: "agent-tool:run-1",
          retain: true,
          metadata: { agentTool: { runId: "run-1" } }
        }
      );
      expect(requestId).toBe("agent-tool:run-1");
      await instance.tasks.wait(requestId);
      expect(instance.tasks.peek(requestId)).toMatchObject({
        status: "completed",
        metadata: { agentTool: { runId: "run-1" } }
      });
      expect(progress).toEqual({ done: 1 });
      instance.host.respond = respond;
    });
  });

  it("a cancel carries the caller's reason to the run", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      let called!: () => void;
      const inRespond = new Promise<void>((resolve) => (called = resolve));
      const respond = instance.host.respond;
      instance.host.respond = async (call) => {
        called();
        await new Promise<void>((resolve) =>
          call.signal.addEventListener("abort", () => resolve(), { once: true })
        );
        return respond(call);
      };
      const { requestId } = await submitTurn(
        instance.deps,
        instance.lane,
        {
          trigger: "server",
          messages: [
            { id: "u1", role: "user", parts: [{ type: "text", text: "Go" }] }
          ]
        },
        { retain: true }
      );
      await inRespond;
      await cancelTurn(instance.deps, requestId, "parent cancelled");
      await instance.tasks.wait(requestId);
      expect(instance.tasks.peek(requestId)).toMatchObject({
        status: "aborted",
        reason: "parent cancelled"
      });
      instance.host.respond = respond;
    });
  });

  it("a tool result that settles its call and lists client tools replaces the stored ones for its continuation", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const session = instance.sessions.session("s1");
      await session.internal_setConfig(
        CHAT_REQUEST_CONTEXT_KEY,
        JSON.stringify({
          clientTools: [{ name: "locate" }],
          body: { keep: true }
        })
      );
      await session.appendMessage({
        id: "u1",
        role: "user",
        parts: []
      } as never);
      await session.appendMessage({
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-locate",
            toolCallId: "c1",
            state: "input-available",
            input: {}
          }
        ]
      } as never);
      const done = instance.nextResult();
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        JSON.stringify({
          type: "cf_agent_tool_result",
          toolCallId: "c1",
          toolName: "locate",
          output: {},
          autoContinue: true,
          clientTools: [{ name: "newer" }]
        })
      );
      await done;
      expect(instance.calls[0].clientTools).toEqual([{ name: "newer" }]);
      expect(
        JSON.parse((await session.internal_config(CHAT_REQUEST_CONTEXT_KEY))!)
      ).toEqual({ clientTools: [{ name: "newer" }], body: { keep: true } });
    });
  });

  it("an answer for a reply the chat moved past, asked to continue, is reported dropped as moved on", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const session = instance.sessions.session("s1");
      await session.appendMessage({
        id: "u1",
        role: "user",
        parts: []
      } as never);
      await session.appendMessage({
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-locate",
            toolCallId: "c1",
            state: "input-available",
            input: {}
          }
        ]
      } as never);
      await session.appendMessage({
        id: "note",
        role: "assistant",
        parts: [{ type: "text", text: "Background job finished." }]
      } as never);
      await answerTool(
        instance.deps,
        instance.lane,
        { kind: "result", toolCallId: "c1", output: {} },
        { autoContinue: true }
      );
      expect(instance.events).toEqual([
        {
          type: "chat:continuation:dropped",
          payload: { requestId: null, reason: "moved_on" }
        }
      ]);
      expect(instance.calls).toHaveLength(0);
    });
  });

  it("a continuation whose reply already went on to the model's answer is skipped and reported as answered", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const session = instance.sessions.session("s1");
      await session.appendMessage({
        id: "u1",
        role: "user",
        parts: []
      } as never);
      await session.appendMessage({
        id: "a1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          {
            type: "tool-locate",
            toolCallId: "c1",
            state: "output-available",
            input: {},
            output: {}
          },
          { type: "step-start" },
          { type: "text", text: "You are in Lisbon." }
        ]
      } as never);
      const done = instance.nextResult();
      await submitTurn(instance.deps, instance.lane, {
        trigger: "tool-answer",
        replyId: "a1"
      });
      expect(await done).toMatchObject({ status: "skipped" });
      expect(instance.calls).toHaveLength(0);
      expect(instance.events.map((event) => event.payload.reason)).toEqual([
        "answered"
      ]);
    });
  });

  it("a tab that answers and asks to continue is offered the continuation's stream", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const session = instance.sessions.session("s1");
      await session.appendMessage({
        id: "u1",
        role: "user",
        parts: []
      } as never);
      await session.appendMessage({
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-locate",
            toolCallId: "c1",
            state: "input-available",
            input: {}
          }
        ]
      } as never);
      const sent: Array<Record<string, unknown>> = [];
      const answering = {
        id: "tab-a",
        readyState: 1,
        send: (text: string) => sent.push(JSON.parse(text))
      } as unknown as Connection;
      const done = instance.nextResult();
      await chatDispatch(
        instance.deps,
        instance.lane,
        answering,
        JSON.stringify({
          type: "cf_agent_tool_result",
          toolCallId: "c1",
          toolName: "locate",
          output: {},
          autoContinue: true
        })
      );
      const result = await done;
      expect(sent).toContainEqual({
        type: "cf_agent_stream_resuming",
        id: result.requestId
      });
    });
  });

  it("an answer that lands while its batch's continuation waits on the model gets a continuation of its own", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const session = instance.sessions.session("s1");
      await session.appendMessage({
        id: "u1",
        role: "user",
        parts: []
      } as never);
      await session.appendMessage({
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-locate",
            toolCallId: "c1",
            state: "input-available",
            input: {}
          },
          {
            type: "tool-other",
            toolCallId: "c2",
            state: "approval-responded",
            input: {},
            approval: { id: "ap-2", approved: true }
          }
        ]
      } as never);
      // The first continuation waits on the model.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const respond = instance.host.respond;
      (instance.host as { respond: typeof respond }).respond = async (call) => {
        await gate;
        return respond(call);
      };
      await answerTool(
        instance.deps,
        instance.lane,
        { kind: "result", toolCallId: "c1", output: {} },
        { autoContinue: true }
      );
      await answerTool(
        instance.deps,
        instance.lane,
        { kind: "result", toolCallId: "c2", output: {} },
        { autoContinue: true }
      );
      const open = instance.tasks.peekList({
        definition: instance.lane.definition,
        lane: instance.lane.lane,
        status: ["pending", "running"],
        results: false
      });
      release();
      expect(open).toHaveLength(2);
    });
  });

  it("a stop drops the continuation an answer already started for the reply that streams", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const release = await streamThenHold(
        instance,
        [
          { type: "start", messageId: "a1" },
          {
            type: "tool-input-available",
            toolCallId: "c1",
            toolName: "ask",
            input: {}
          }
        ],
        [],
        JSON.stringify({
          type: "cf_agent_use_chat_request",
          id: "r1",
          init: {
            method: "POST",
            body: JSON.stringify({
              messages: [
                {
                  id: "u1",
                  role: "user",
                  parts: [{ type: "text", text: "Hi" }]
                }
              ],
              clientTools: [{ name: "ask" }]
            })
          }
        })
      );
      // The batch's only call is answered: its continuation waits behind
      // the reply. Then the user stops the reply.
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        toolResult("c1", true)
      );
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        JSON.stringify({ type: "cf_agent_chat_request_cancel", id: "r1" })
      );
      release();
      await instance.resultFor("r1");
      await vi.waitFor(() =>
        expect(
          instance.tasks.peekList({
            definition: instance.lane.definition,
            lane: instance.lane.lane,
            status: ["pending", "running"],
            results: false
          })
        ).toHaveLength(0)
      );
      expect(
        instance.calls.filter((c) => c.trigger === "tool-answer")
      ).toHaveLength(0);
      expect(instance.events.map((e) => e.payload.reason)).toEqual(["stopped"]);
    });
  });

  it("a stop of a continuation that has not streamed drops the next continuation of its reply", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const session = instance.sessions.session("s1");
      await session.appendMessage({
        id: "u1",
        role: "user",
        parts: []
      } as never);
      await session.appendMessage({
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-locate",
            toolCallId: "c1",
            state: "input-available",
            input: {}
          },
          {
            type: "tool-other",
            toolCallId: "c2",
            state: "approval-responded",
            input: {},
            approval: { id: "ap-2", approved: true }
          }
        ]
      } as never);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const respond = instance.host.respond;
      (instance.host as { respond: typeof respond }).respond = async (call) => {
        await gate;
        return respond(call);
      };
      await answerTool(
        instance.deps,
        instance.lane,
        { kind: "result", toolCallId: "c1", output: {} },
        { autoContinue: true }
      );
      await answerTool(
        instance.deps,
        instance.lane,
        { kind: "result", toolCallId: "c2", output: {} },
        { autoContinue: true }
      );
      const [first] = instance.tasks.peekList({
        definition: instance.lane.definition,
        lane: instance.lane.lane,
        status: ["running"],
        results: false
      });
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        JSON.stringify({
          type: "cf_agent_chat_request_cancel",
          id: first.runId
        })
      );
      release();
      await vi.waitFor(() =>
        expect(
          instance.tasks.peekList({
            definition: instance.lane.definition,
            lane: instance.lane.lane,
            status: ["pending", "running"],
            results: false
          })
        ).toHaveLength(0)
      );
      expect(instance.calls).toHaveLength(1);
    });
  });

  it("a caller's signal loses the turn's listener when the turn ends", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const signal = new AbortController().signal;
      let listeners = 0;
      const add = signal.addEventListener.bind(signal);
      const remove = signal.removeEventListener.bind(signal);
      signal.addEventListener = ((...args: Parameters<typeof add>) => {
        if (args[0] === "abort") listeners++;
        add(...args);
      }) as typeof add;
      signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
        if (args[0] === "abort") listeners--;
        remove(...args);
      }) as typeof remove;
      const done = instance.nextResult();
      await submitTurn(
        instance.deps,
        instance.lane,
        { trigger: "server" },
        { signal }
      );
      await done;
      await vi.waitFor(() => expect(listeners).toBe(0));
    });
  });

  it("a regenerate a later question overtook while it waited is skipped and leaves the stored context alone", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const release = await streamThenHold(instance, [
        { type: "start", messageId: "a1" }
      ]);
      const context = await instance.sessions
        .session("s1")
        .internal_config(CHAT_REQUEST_CONTEXT_KEY);
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        JSON.stringify({
          type: "cf_agent_use_chat_request",
          id: "rg",
          init: {
            method: "POST",
            body: JSON.stringify({
              trigger: "regenerate-message",
              messages: [
                {
                  id: "u1",
                  role: "user",
                  parts: [{ type: "text", text: "Hi" }]
                }
              ],
              owner: "tab-b"
            })
          }
        })
      );
      // Another tab's question is stored while the regenerate waits.
      await instance.sessions
        .session("s1")
        .appendMessage({ id: "u2", role: "user", parts: [] } as never);
      release();
      expect(await instance.resultFor("rg")).toMatchObject({
        status: "skipped"
      });
      expect(instance.calls.filter((c) => c.requestId === "rg")).toEqual([]);
      expect(
        await instance.sessions
          .session("s1")
          .internal_config(CHAT_REQUEST_CONTEXT_KEY)
      ).toBe(context);
    });
  });

  it("a request's end frame names the user messages it came from", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const sent: Array<Record<string, unknown>> = [];
      const sender = {
        id: "tab-a",
        readyState: 1,
        send: (text: string) => sent.push(JSON.parse(text))
      } as unknown as Connection;
      instance.tabs.push(sender);
      const done = instance.nextResult();
      await chatDispatch(
        instance.deps,
        instance.lane,
        sender,
        chatRequestWith("r1", "u1", "Hi")
      );
      await done;
      expect(sent.find((frame) => frame.done === true)).toMatchObject({
        id: "r1",
        messageIds: ["u1"]
      });
    });
  });

  it("a clear tells the tab of a waiting request that it was skipped", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const sent: Array<Record<string, unknown>> = [];
      const sender = recordingTab("tab-x", sent);
      const deps = {
        ...instance.deps,
        webSockets: { getConnections: () => [sender] } as never
      };
      const finish = await holdFirstTurn(instance, instance.lane);
      await chatDispatch(
        deps,
        instance.lane,
        sender,
        chatRequestWith("r2", "u2", "two")
      );
      await clearChat(deps, instance.lane);
      await finish().catch(() => {});
      expect(sent).toContainEqual(
        expect.objectContaining({ id: "r2", done: true, outcome: "skipped" })
      );
    });
  });

  it("the other tabs get the stored transcript with the reply before the end frame", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const asked: Array<Record<string, unknown>> = [];
      const watching: Array<Record<string, unknown>> = [];
      const sender = recordingTab("tab-a", asked);
      instance.tabs.push(sender, recordingTab("tab-b", watching));
      const done = instance.nextResult();
      await chatDispatch(
        instance.deps,
        instance.lane,
        sender,
        chatRequestWith("r1", "u1", "Hi")
      );
      await done;
      const list = watching.findIndex(
        (frame) =>
          frame.type === "cf_agent_chat_messages" &&
          JSON.stringify(frame).includes("reply-1")
      );
      const end = watching.findIndex((frame) => frame.done === true);
      expect(list).toBeGreaterThanOrEqual(0);
      expect(list).toBeLessThan(end);
      expect(
        asked.some((frame) => frame.type === "cf_agent_chat_messages")
      ).toBe(false);
    });
  });

  it("a tab that did not answer is told there is nothing to resume while another tab's continuation waits", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const session = instance.sessions.session("s1");
      await session.appendMessage({
        id: "u1",
        role: "user",
        parts: []
      } as never);
      await session.appendMessage({
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-ask",
            toolCallId: "c1",
            state: "input-available",
            input: {}
          }
        ]
      } as never);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const respond = instance.host.respond;
      (instance.host as { respond: typeof respond }).respond = async (call) => {
        await gate;
        return respond(call);
      };
      const answeredBy: Array<Record<string, unknown>> = [];
      const other: Array<Record<string, unknown>> = [];
      const done = instance.nextResult();
      await answerTool(
        instance.deps,
        instance.lane,
        { kind: "result", toolCallId: "c1", output: {} },
        { autoContinue: true, connection: recordingTab("tab-a", answeredBy) }
      );
      await resumeChat(
        instance.deps,
        instance.lane,
        recordingTab("tab-b", other)
      );
      release();
      await done;
      expect(other).toEqual([{ type: "cf_agent_stream_resume_none" }]);
    });
  });

  it("a clear tells a tab waiting for a stream at once that none is coming", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const respond = instance.host.respond;
      (instance.host as { respond: typeof respond }).respond = async (call) => {
        await gate;
        return respond(call);
      };
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        chatRequestWith("r1", "u1", "Hi")
      );
      const sent: Array<Record<string, unknown>> = [];
      await resumeChat(
        instance.deps,
        instance.lane,
        recordingTab("tab-w", sent)
      );
      // The clear waits for the turn, which waits on its model.
      const cleared = clearChat(instance.deps, instance.lane);
      await vi.waitFor(() =>
        expect(sent.map((frame) => frame.type)).toEqual([
          "cf_agent_stream_pending",
          "cf_agent_stream_resume_none"
        ])
      );
      release();
      await cleared;
    });
  });
});
