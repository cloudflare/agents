import { CHAT_REQUEST_CONTEXT_KEY } from "../../chat";
import {
  env,
  runDurableObjectAlarm,
  runInDurableObject
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Connection } from "agents";
import type { UIMessageChunk } from "ai";
import type { ChatTurnHostObject } from "../capabilities/chat-turn";
import {
  type ChatLane,
  answerTool,
  cancelTurn,
  chatDispatch,
  clearChat,
  forgetTab,
  replayTurn,
  resumeChat,
  submitTurn
} from "../../chat/chat-functions";
import {
  type ChatHooks,
  chatTurnDefinition,
  chatTurnStreamId,
  offeredIn,
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
      const replayed = sent.filter(
        (frame) => frame.replay === true && frame.replayComplete !== true
      );
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

  it("a live tool answer's continuation never extends a question queued meanwhile: the chat moved on, so it is dropped", async () => {
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
      // The queued question was answered after a1, so the continuation has
      // nothing to answer (as the release drops it): it calls no model and
      // writes into no reply.
      expect(
        instance.calls.find((c) => c.trigger === "tool-answer")
      ).toBeUndefined();
      expect(instance.events.map((e) => e.payload.reason)).toEqual([
        "moved_on"
      ]);
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
      // The tab was offered the stream, as a resume request does.
      offeredIn(instance.streams).set("tab-r", "r1");
      await replayTurn(instance.deps, recordingTab("tab-r", sent), "r1");
      // Every chunk, then the replay's end for a live stream.
      expect(
        sent.filter((frame) => frame.replayComplete !== true)
      ).toHaveLength(5);
      expect(sent.at(-1)).toMatchObject({ replayComplete: true });
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

  it("a tab's stop names only a chat turn: another Task run of the agent is left alone", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      instance.tasks.register("__cf_test_app_job", async () =>
        TaskSettlement.retry(Date.now() + 60_000)
      );
      await instance.lifecycle.start();
      const { runId } = await instance.tasks.run(
        "__cf_test_app_job",
        {} as never,
        {
          start: "now"
        }
      );
      expect(instance.tasks.peek(runId)?.status).toBe("pending");
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        JSON.stringify({ type: "cf_agent_chat_request_cancel", id: runId })
      );
      expect(instance.tasks.peek(runId)?.status).toBe("pending");
    });
  });

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

  it("a tab that resumes while a turn waits out its retry backoff gets the next attempt's chunks", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    const sent: Array<Record<string, unknown>> = [];
    await runInDurableObject(
      stub,
      async (instance: ChatTurnHostObject, state) => {
        const requestId = await cutOffIntoBackoff(instance);
        const back = recordingTab("tab-back", sent);
        const send = back.send.bind(back);
        (back as { send: typeof send }).send = (text: string) => {
          send(text);
          const frame = JSON.parse(text) as { type?: string; id?: string };
          if (frame.type === "cf_agent_stream_resuming") {
            void chatDispatch(
              instance.deps,
              instance.lane,
              back,
              JSON.stringify({
                type: "cf_agent_stream_resume_ack",
                id: frame.id
              })
            );
          }
        };
        instance.tabs.push(back);
        await resumeChat(instance.deps, instance.lane, back, "p1", [requestId]);
        instance.reply = [
          { type: "text-delta", id: "t1", delta: " more" },
          { type: "text-end", id: "t1" },
          { type: "finish" }
        ];
        state.storage.sql.exec(
          "UPDATE cf_agents_task_runs SET next_at = ? WHERE run_id = ?",
          Date.now(),
          requestId
        );
        await state.storage.setAlarm(Date.now());
      }
    );
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async () => {
      await vi.waitFor(() =>
        expect(sent.some((frame) => frame.done === true)).toBe(true)
      );
      expect(
        sent.some(
          (frame) =>
            frame.type === "cf_agent_use_chat_response" &&
            String(frame.body).includes('" more"')
        )
      ).toBe(true);
    });
  });

  it("a stop while a turn waits out its retry backoff ends the turn once: the host hears of it, and its recovery is over", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      const requestId = await cutOffIntoBackoff(instance);
      const ended: unknown[] = [];
      const deps = {
        ...instance.deps,
        turnEnded: (result: unknown) => void ended.push(result)
      };
      expect(await cancelTurn(deps, requestId)).toBe(true);
      expect(ended).toEqual([
        expect.objectContaining({ requestId, status: "aborted" })
      ]);
      // Its recovery is over: a host showing it as recovering stops.
      expect(
        instance.events.filter(
          (event) =>
            event.type === "chat:recovery:skipped" &&
            event.payload.requestId === requestId
        )
      ).toHaveLength(1);
    });
  });

  it("a stop while a turn waits out its retry backoff tells every tab the request ended", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      const requestId = await cutOffIntoBackoff(instance);
      const sent: Array<Record<string, unknown>> = [];
      instance.tabs.push(recordingTab("tab-w", sent));
      expect(await cancelTurn(instance.deps, requestId)).toBe(true);
      expect(sent).toContainEqual(
        expect.objectContaining({
          type: "cf_agent_use_chat_response",
          id: requestId,
          done: true,
          outcome: "aborted"
        })
      );
    });
  });

  it.each([
    ["a stop", "user_cancelled"],
    ["a clear", "cleared"]
  ] as const)(
    "%s while a turn waits out its retry backoff ends its recovery: the hosts' recovering status goes off",
    async (how, reason) => {
      const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
        const requestId = await cutOffIntoBackoff(instance);
        instance.events.length = 0;
        if (how === "a stop") await cancelTurn(instance.deps, requestId);
        else await clearChat(instance.deps, instance.lane);
        expect(instance.events).toContainEqual({
          type: "chat:recovery:skipped",
          payload: expect.objectContaining({ requestId, reason })
        });
      });
    }
  );

  it("a tab that comes back for a request that completed while it was away is sent the transcript before the end", async () => {
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
      const sent: Array<Record<string, unknown>> = [];
      const back = recordingTab("tab-stale", sent);
      await resumeChat(instance.deps, instance.lane, back, undefined, ["r1"]);
      await replayTurn(instance.deps, back, "r1");
      // The page holds whatever it had drawn when it left: the stored
      // messages replace it, then the request ends.
      expect(sent.map((frame) => frame.type)).toEqual([
        "cf_agent_stream_resuming",
        "cf_agent_chat_messages",
        "cf_agent_use_chat_response"
      ]);
      const history = await instance.sessions.session("s1").getHistory();
      expect(
        (sent[1].messages as Array<{ id: string }>).map((m) => m.id)
      ).toEqual(history.map((message) => message.id));
    });
  });

  it("a stop while a turn waits out its retry backoff stores its reply before the next turn stores its question", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      const requestId = await cutOffIntoBackoff(instance);
      // The next question waits behind it.
      await submitTurn(
        instance.deps,
        instance.lane,
        {
          trigger: "submit-message",
          messages: [
            { id: "u2", role: "user", parts: [{ type: "text", text: "Next" }] }
          ]
        } as never,
        { requestId: "r2" }
      );
      instance.reply = [
        { type: "start", messageId: "a2" },
        { type: "text-start", id: "t2" },
        { type: "text-delta", id: "t2", delta: "Answer" },
        { type: "text-end", id: "t2" },
        { type: "finish" }
      ];
      expect(await cancelTurn(instance.deps, requestId)).toBe(true);
      await instance.resultFor("r2");
      const history = await instance.sessions.session("s1").getHistory();
      expect(history.map((message) => message.id)).toEqual([
        "u1",
        "a1",
        "u2",
        "a2"
      ]);
    });
  });

  it("a stop while a turn streams stores its reply before the next turn stores its question", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      // The first reply streams some text and stays open.
      const respond = instance.host.respond;
      let read!: () => void;
      const streamed = new Promise<void>((resolve) => (read = resolve));
      let first = true;
      instance.host.respond = async (call) => {
        if (!first) return respond(call);
        first = false;
        const chunks = [
          { type: "start", messageId: "a1" },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "Part" }
        ];
        return new ReadableStream({
          pull(controller) {
            const chunk = chunks.shift();
            // Asked for more: what was sent has been taken.
            if (chunk) controller.enqueue(chunk);
            else read();
          }
        }) as never;
      };
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        chatRequest("r1", "one")
      );
      await streamed;
      // The next question waits behind it, and the first is stopped.
      await submitTurn(
        instance.deps,
        instance.lane,
        {
          trigger: "submit-message",
          messages: [
            { id: "u2", role: "user", parts: [{ type: "text", text: "Next" }] }
          ]
        } as never,
        { requestId: "r2" }
      );
      expect(await cancelTurn(instance.deps, "r1")).toBe(true);
      await instance.resultFor("r2");
      const history = await instance.sessions.session("s1").getHistory();
      expect(history.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant"
      ]);
      expect(history[2].id).toBe("u2");
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
      // The stored messages come first, then the request's end.
      expect(sent.at(-1)).toMatchObject({
        type: "cf_agent_use_chat_response",
        id: "r1",
        done: true,
        replay: true,
        outcome: "completed"
      });
    });
  });

  it("a tab that names no request is offered the last turn when it ended in an error, until a later turn ends (#1645)", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const respond = instance.host.respond;
      instance.host.respond = async () => {
        throw new Error("Provider returned HTTP 500.");
      };
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        chatRequest("r1", "Hi")
      );
      await instance.resultFor("r1");

      // A page loaded afterwards waits on nothing, and still learns of it.
      const sent: Array<Record<string, unknown>> = [];
      const fresh = recordingTab("tab-fresh", sent);
      await resumeChat(instance.deps, instance.lane, fresh, "p1");
      expect(sent).toEqual([
        { type: "cf_agent_stream_resuming", id: "r1", probeId: "p1" }
      ]);
      await chatDispatch(
        instance.deps,
        instance.lane,
        fresh,
        JSON.stringify({ type: "cf_agent_stream_resume_ack", id: "r1" })
      );
      // The stored messages come first, then the request's end.
      expect(sent.at(-1)).toMatchObject({
        type: "cf_agent_use_chat_response",
        id: "r1",
        error: true,
        body: "Provider returned HTTP 500."
      });

      // A later turn that ends well supersedes it.
      instance.host.respond = respond;
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        chatRequestWith("r2", "u2", "Again")
      );
      await instance.resultFor("r2");
      const later: Array<Record<string, unknown>> = [];
      await resumeChat(
        instance.deps,
        instance.lane,
        recordingTab("tab-later", later),
        "p2"
      );
      expect(later).toEqual([
        { type: "cf_agent_stream_resume_none", reason: "idle", probeId: "p2" }
      ]);
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
      expect(sent).toEqual([
        { type: "cf_agent_stream_resume_none", reason: "idle" }
      ]);
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
      // The stored messages come first, then the request's end.
      expect(sent.at(-1)).toMatchObject({
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

  it("a continuation stopped after its first text keeps one text part after the answered call", async () => {
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
            type: "tool-getUserLocation",
            toolCallId: "c1",
            state: "input-available",
            input: {}
          }
        ]
      } as never);
      // The continuation streams some text, then waits until it is stopped.
      let streamed!: () => void;
      const started = new Promise<void>((resolve) => (streamed = resolve));
      (instance.host as { respond: typeof instance.host.respond }).respond =
        async (call) =>
          new ReadableStream<UIMessageChunk>({
            async start(controller) {
              controller.enqueue({ type: "start" });
              controller.enqueue({ type: "text-start", id: "t2" });
              controller.enqueue({
                type: "text-delta",
                id: "t2",
                delta: "You are"
              });
              streamed();
              await new Promise<void>((resolve) =>
                call.signal.addEventListener("abort", () => resolve(), {
                  once: true
                })
              );
              controller.close();
            }
          });
      const sent: Array<Record<string, unknown>> = [];
      instance.tabs.push(recordingTab("tab-w", sent));
      const done = instance.nextResult();
      await answerTool(
        instance.deps,
        instance.lane,
        { kind: "result", toolCallId: "c1", output: { city: "Lisbon" } },
        { autoContinue: true }
      );
      await started;
      // The tabs were sent the text before the stop.
      await vi.waitFor(() =>
        expect(
          sent.some((frame) => String(frame.body).includes("You are"))
        ).toBe(true)
      );
      const [running] = instance.tasks.peekList({
        definition: instance.lane.definition,
        lane: instance.lane.lane,
        status: ["running"],
        results: false
      });
      await cancelTurn(instance.deps, running.runId);
      await done;
      const reply = (await session.getMessage("a1")) as unknown as {
        parts: Array<{ type: string; text?: string }>;
      };
      expect(reply.parts.map((part) => part.type)).toEqual([
        "tool-getUserLocation",
        "text"
      ]);
    });
  });

  it("a stop that drops a continuation not yet started sends no end for it: the tab never sent that request", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const sent: Array<Record<string, unknown>> = [];
      // The tab that sent the request answers its call and stops it.
      const asker = recordingTab("tab-s", sent);
      instance.tabs.push(asker);
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
        asker,
        toolResult("c1", true)
      );
      // The continuation is a run by now, waiting behind the reply.
      await vi.waitFor(() =>
        expect(
          instance.tasks
            .peekList({
              definition: instance.lane.definition,
              lane: instance.lane.lane,
              status: ["pending"],
              results: false
            })
            .some(
              (run) =>
                instance.tasks.inputOf<{ trigger?: string }>(run.runId)
                  ?.trigger === "tool-answer"
            )
        ).toBe(true)
      );
      await chatDispatch(
        instance.deps,
        instance.lane,
        asker,
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
      // One end, the stopped request's own.
      expect(
        sent
          .filter(
            (frame) =>
              frame.type === "cf_agent_use_chat_response" && frame.done === true
          )
          .map((frame) => frame.id)
      ).toEqual(["r1"]);
    });
  });

  it("a continuation stopped after its first text keeps one text part after the answered call", async () => {
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
            type: "tool-getUserLocation",
            toolCallId: "c1",
            state: "input-available",
            input: {}
          }
        ]
      } as never);
      // The continuation streams some text, then waits until it is stopped.
      let streamed!: () => void;
      const started = new Promise<void>((resolve) => (streamed = resolve));
      (instance.host as { respond: typeof instance.host.respond }).respond =
        async (call) =>
          new ReadableStream<UIMessageChunk>({
            async start(controller) {
              controller.enqueue({ type: "start" });
              controller.enqueue({ type: "text-start", id: "t2" });
              controller.enqueue({
                type: "text-delta",
                id: "t2",
                delta: "You are"
              });
              streamed();
              await new Promise<void>((resolve) =>
                call.signal.addEventListener("abort", () => resolve(), {
                  once: true
                })
              );
              controller.close();
            }
          });
      const sent: Array<Record<string, unknown>> = [];
      instance.tabs.push(recordingTab("tab-w", sent));
      const done = instance.nextResult();
      await answerTool(
        instance.deps,
        instance.lane,
        { kind: "result", toolCallId: "c1", output: { city: "Lisbon" } },
        { autoContinue: true }
      );
      await started;
      // The tabs were sent the text before the stop.
      await vi.waitFor(() =>
        expect(
          sent.some((frame) => String(frame.body).includes("You are"))
        ).toBe(true)
      );
      const [running] = instance.tasks.peekList({
        definition: instance.lane.definition,
        lane: instance.lane.lane,
        status: ["running"],
        results: false
      });
      await cancelTurn(instance.deps, running.runId);
      await done;
      const reply = (await session.getMessage("a1")) as unknown as {
        parts: Array<{ type: string; text?: string }>;
      };
      expect(reply.parts.map((part) => part.type)).toEqual([
        "tool-getUserLocation",
        "text"
      ]);
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

  it("a recovered reply's stored transcript goes to the tab that asked too, once, before the end frame", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    const sent: Array<Record<string, unknown>> = [];
    await runInDurableObject(
      stub,
      async (instance: ChatTurnHostObject, state) => {
        await instance.lifecycle.start();
        // The first attempt streams some text, then fails transiently.
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
        const sender = recordingTab("tab-a", sent);
        instance.tabs.push(sender);
        await chatDispatch(
          instance.deps,
          instance.lane,
          sender,
          chatRequestWith("r1", "u1", "Hi")
        );
        await vi.waitFor(() =>
          expect(instance.tasks.peek("r1")).toMatchObject({
            status: "pending",
            waitReason: "retry"
          })
        );
        // The next attempt answers.
        instance.reply = [
          { type: "start", messageId: "a1" },
          { type: "text-start", id: "t2" },
          { type: "text-delta", id: "t2", delta: " and the rest" },
          { type: "text-end", id: "t2" },
          { type: "finish" }
        ];
        state.storage.sql.exec(
          "UPDATE cf_agents_task_runs SET next_at = ? WHERE run_id = 'r1'",
          Date.now()
        );
        await state.storage.setAlarm(Date.now());
      }
    );
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await vi.waitFor(() =>
        expect(sent.some((frame) => frame.done === true)).toBe(true)
      );
      const end = sent.findIndex((frame) => frame.done === true);
      const lists = sent.filter(
        (frame) => frame.type === "cf_agent_chat_messages"
      );
      expect(lists).toHaveLength(1);
      expect(sent.indexOf(lists[0])).toBeLessThan(end);
      expect(lists[0].messages).toEqual(
        await instance.sessions.session("s1").getHistory()
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

  it("the tab that answered gets its continuation's chunks once, however late its ack comes", async () => {
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
      // The model sends one delta, then the rest once the tab has acked.
      let acked!: () => void;
      const ack = new Promise<void>((resolve) => (acked = resolve));
      (instance.host as { respond: typeof instance.host.respond }).respond =
        async () =>
          new ReadableStream<UIMessageChunk>({
            async start(controller) {
              controller.enqueue({ type: "text-start", id: "t2" });
              controller.enqueue({ type: "text-delta", id: "t2", delta: "A" });
              await ack;
              controller.enqueue({ type: "text-delta", id: "t2", delta: "B" });
              controller.enqueue({ type: "text-end", id: "t2" });
              controller.enqueue({ type: "finish" });
              controller.close();
            }
          });
      const sent: Array<Record<string, unknown>> = [];
      const answering = recordingTab("tab-a", sent);
      instance.tabs.push(answering);
      // The tab's ack arrives after the first delta was streamed (a tab's
      // round trip is longer than the model's first chunk).
      let offered: string | undefined;
      const send = answering.send.bind(answering);
      (answering as { send: typeof send }).send = (text: string) => {
        send(text);
        const frame = JSON.parse(text) as { type?: string; id?: string };
        if (frame.type === "cf_agent_stream_resuming") offered = frame.id;
        if (
          offered !== undefined &&
          frame.type === "cf_agent_use_chat_response" &&
          String((frame as { body?: unknown }).body).includes("text-delta")
        ) {
          const id = offered;
          offered = undefined;
          void chatDispatch(
            instance.deps,
            instance.lane,
            answering,
            JSON.stringify({ type: "cf_agent_stream_resume_ack", id })
          ).then(acked);
        }
      };
      const done = instance.nextResult();
      await answerTool(
        instance.deps,
        instance.lane,
        { kind: "result", toolCallId: "c1", output: {} },
        { autoContinue: true, connection: answering }
      );
      // A tab that never got a live delta acks at the offer's replay.
      setTimeout(() => acked(), 2000);
      await done;
      const deltas = sent.filter(
        (frame) =>
          frame.type === "cf_agent_use_chat_response" &&
          String(frame.body).includes('"delta":"A"')
      );
      expect(deltas).toHaveLength(1);
    });
  });

  for (const withIds of [false, true]) {
    it(`a tab that reconnects, asks to resume${withIds ? " its request" : ""}, then answers gets its continuation's chunks once`, async () => {
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
        // The model sends one delta, then the rest once the tab has acked
        // the offer of its continuation (or after a while, if none comes).
        let acked!: () => void;
        const ack = new Promise<void>((resolve) => (acked = resolve));
        setTimeout(() => acked(), 1500);
        (instance.host as { respond: typeof instance.host.respond }).respond =
          async () =>
            new ReadableStream<UIMessageChunk>({
              async start(controller) {
                controller.enqueue({ type: "text-start", id: "t2" });
                controller.enqueue({
                  type: "text-delta",
                  id: "t2",
                  delta: "A"
                });
                await ack;
                controller.enqueue({
                  type: "text-delta",
                  id: "t2",
                  delta: "B"
                });
                controller.enqueue({ type: "text-end", id: "t2" });
                controller.enqueue({ type: "finish" });
                controller.close();
              }
            });
        const sent: Array<Record<string, unknown>> = [];
        // A new tab (the one that asked closed after the call): it asks to
        // resume, then answers the tool, and acks any offer it is sent.
        const tab = recordingTab("tab-new", sent);
        const send = tab.send.bind(tab);
        // Its ack arrives after the first live delta (a tab's round trip is
        // longer than the model's first chunk).
        let offered: string | undefined;
        (tab as { send: typeof send }).send = (text: string) => {
          send(text);
          const frame = JSON.parse(text) as { type?: string; id?: string };
          if (frame.type === "cf_agent_stream_resuming") offered = frame.id;
          if (
            offered !== undefined &&
            frame.type === "cf_agent_use_chat_response" &&
            String((frame as { body?: unknown }).body).includes("text-delta")
          ) {
            const id = offered;
            offered = undefined;
            void chatDispatch(
              instance.deps,
              instance.lane,
              tab,
              JSON.stringify({ type: "cf_agent_stream_resume_ack", id })
            ).then(acked);
          }
        };
        instance.tabs.push(tab);
        await resumeChat(
          instance.deps,
          instance.lane,
          tab,
          "p1",
          withIds ? ["r-ask"] : []
        );
        const done = instance.nextResult();
        await answerTool(
          instance.deps,
          instance.lane,
          { kind: "result", toolCallId: "c1", output: {} },
          { autoContinue: true, connection: tab }
        );
        await done;
        await vi.waitFor(() =>
          expect(sent.some((frame) => frame.done === true)).toBe(true)
        );
        // It was offered its continuation (rv-2's path), and every chunk
        // reached it once: live, or replayed, never both.
        expect(sent.map((frame) => frame.type)).toContain(
          "cf_agent_stream_resuming"
        );
        for (const delta of ["A", "B"]) {
          expect(
            sent.filter(
              (frame) =>
                frame.type === "cf_agent_use_chat_response" &&
                String(frame.body).includes(`"delta":"${delta}"`)
            )
          ).toHaveLength(1);
        }
      });
    });
  }

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

  it("a request whose record cannot be written ends on its tab with an error frame", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const sent: Array<Record<string, unknown>> = [];
      const failing = {
        ...instance.deps,
        tasks: new Proxy(instance.tasks, {
          get(target, key, receiver) {
            if (key === "run") {
              return async () => {
                throw new Error("SQLITE_TOOBIG: string or blob too big");
              };
            }
            const value = Reflect.get(target, key, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          }
        })
      };
      await chatDispatch(
        failing,
        instance.lane,
        recordingTab("tab-x", sent),
        chatRequestWith("r1", "u1", "Hi")
      );
      expect(sent).toContainEqual(
        expect.objectContaining({ id: "r1", done: true, error: true })
      );
      expect(String(sent[0].body)).toContain("SQLITE_TOOBIG");
    });
  });

  it("the list sent with a reply names the messages of waiting requests as queued", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const watching: Array<Record<string, unknown>> = [];
      instance.tabs.push(recordingTab("tab-b", watching));
      const finish = await holdFirstTurn(instance, instance.lane);
      await chatDispatch(
        instance.deps,
        instance.lane,
        recordingTab("tab-c", []),
        chatRequestWith("r2", "u2", "two")
      );
      await finish();
      const lists = watching.filter(
        (frame) => frame.type === "cf_agent_chat_messages"
      );
      expect(
        lists.some(
          (frame) => JSON.stringify(frame.queuedMessageIds) === '["u2"]'
        )
      ).toBe(true);
    });
  });

  it("a chat request with no messages ends on its tab, is kept for a resume by its id, and is published", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const sent: Array<Record<string, unknown>> = [];
      await chatDispatch(
        instance.deps,
        instance.lane,
        recordingTab("tab-x", sent),
        JSON.stringify({
          type: "cf_agent_use_chat_request",
          id: "bad",
          init: { method: "POST", body: JSON.stringify({ text: "hi" }) }
        })
      );
      expect(sent).toContainEqual(
        expect.objectContaining({ id: "bad", done: true, error: true })
      );
      expect(instance.events.map((e) => [e.type, e.payload.stage])).toEqual([
        ["chat:request:failed", "parse"]
      ]);
      const back: Array<Record<string, unknown>> = [];
      await resumeChat(
        instance.deps,
        instance.lane,
        recordingTab("tab-x2", back),
        undefined,
        ["bad"]
      );
      expect(back[0]).toMatchObject({
        type: "cf_agent_stream_resuming",
        id: "bad"
      });
    });
  });

  it("a host turn told to store its context keeps the stored tools it did not bring", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const session = instance.sessions.session("s1");
      await session.internal_setConfig(
        CHAT_REQUEST_CONTEXT_KEY,
        JSON.stringify({
          clientTools: [{ name: "pick" }],
          body: { model: "a" }
        })
      );
      const done = instance.nextResult();
      await submitTurn(
        instance.deps,
        instance.lane,
        { trigger: "server", body: { model: "b" } },
        { storeContext: true }
      );
      await done;
      expect(instance.calls[0].clientTools).toEqual([{ name: "pick" }]);
      expect(
        JSON.parse((await session.internal_config(CHAT_REQUEST_CONTEXT_KEY))!)
      ).toEqual({ clientTools: [{ name: "pick" }], body: { model: "b" } });
    });
  });

  it("a continue told to store its context that has nothing to continue leaves the context alone", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const session = instance.sessions.session("s1");
      const before = JSON.stringify({ body: { model: "stored" } });
      await session.internal_setConfig(CHAT_REQUEST_CONTEXT_KEY, before);
      await session.appendMessage({
        id: "u1",
        role: "user",
        parts: []
      } as never);
      const done = instance.nextResult();
      await submitTurn(
        instance.deps,
        instance.lane,
        { trigger: "server", mode: "continue", body: { model: "skipped" } },
        { storeContext: true }
      );
      expect(await done).toMatchObject({
        status: "skipped",
        reason: "nothing-to-continue"
      });
      expect(await session.internal_config(CHAT_REQUEST_CONTEXT_KEY)).toBe(
        before
      );
    });
  });

  it("a question sent again without the replies after it is answered in their place", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      let done = instance.nextResult();
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        chatRequestWith("r1", "u1", "Hi")
      );
      await done;
      instance.reply = [
        { type: "start", messageId: "reply-2" },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Again" },
        { type: "text-end", id: "t1" },
        { type: "finish" }
      ];
      done = instance.nextResult();
      await chatDispatch(
        instance.deps,
        instance.lane,
        tab,
        chatRequestWith("r2", "u1", "Hi")
      );
      await done;
      const ids = (await instance.sessions.session("s1").getHistory()).map(
        (m) => m.id
      );
      expect(ids).toEqual(["u1", "reply-2"]);
    });
  });

  it("a continuation whose reply later messages moved past is skipped and reported as moved on", async () => {
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
            state: "output-available",
            input: {},
            output: {}
          }
        ]
      } as never);
      await session.appendMessage({
        id: "u2",
        role: "user",
        parts: []
      } as never);
      const done = instance.nextResult();
      await submitTurn(instance.deps, instance.lane, {
        trigger: "tool-answer",
        replyId: "a1"
      });
      expect(await done).toMatchObject({ status: "skipped" });
      expect(instance.calls).toHaveLength(0);
      expect(instance.events.map((e) => e.payload.reason)).toEqual([
        "moved_on"
      ]);
    });
  });

  it("a repeated decision does not land on an older message that holds the same call", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const session = instance.sessions.session("s1");
      const asking = (id: string) =>
        ({
          id,
          role: "assistant",
          parts: [
            {
              type: "tool-del",
              toolCallId: "c1",
              state: "approval-requested",
              input: {},
              approval: { id: `ap-${id}` }
            }
          ]
        }) as never;
      await session.appendMessage({
        id: "u1",
        role: "user",
        parts: []
      } as never);
      await session.appendMessage(asking("a1"));
      await session.appendMessage(asking("a2"));
      for (let i = 0; i < 2; i++) {
        await answerTool(instance.deps, instance.lane, {
          kind: "approval",
          toolCallId: "c1",
          approved: false
        });
      }
      expect(JSON.stringify(await session.getMessage("a2"))).toContain(
        "output-denied"
      );
      expect(JSON.stringify(await session.getMessage("a1"))).toContain(
        "approval-requested"
      );
    });
  });

  it("a tab offered a stream gets none of its live frames until it acks, then the replay and the rest", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const release = await streamThenHold(instance, [
        { type: "start", messageId: "a1" },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "one" }
      ]);
      const sent: Array<Record<string, unknown>> = [];
      const back = recordingTab("tab-back", sent);
      instance.tabs.push(back);
      await resumeChat(instance.deps, instance.lane, back);
      expect(sent[0]).toMatchObject({
        type: "cf_agent_stream_resuming",
        id: "r1"
      });
      release();
      await instance.resultFor("r1");
      // Nothing of r1 reached it live: it had not acked.
      expect(
        sent.filter(
          (frame) =>
            frame.id === "r1" && frame.type === "cf_agent_use_chat_response"
        )
      ).toEqual([]);
    });
  });

  it("live frames carry each chunk's seq, and a replay repeats them and ends a live stream with replayComplete", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const live: Array<Record<string, unknown>> = [];
      instance.tabs.push(recordingTab("tab-live", live));
      const release = await streamThenHold(instance, [
        { type: "start", messageId: "a1" },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "one" }
      ]);
      const back: Array<Record<string, unknown>> = [];
      const tabBack = recordingTab("tab-back", back);
      await resumeChat(instance.deps, instance.lane, tabBack);
      await replayTurn(instance.deps, tabBack, "r1");
      release();
      await instance.resultFor("r1");
      const liveSeqs = live
        .filter((f) => f.id === "r1" && f.done === false && f.body)
        .map((f) => f.seq);
      const replayed = back.filter((f) => f.replay === true && f.body);
      expect(liveSeqs.slice(0, replayed.length)).toEqual(
        replayed.map((f) => f.seq)
      );
      expect(typeof liveSeqs[0]).toBe("number");
      expect(back.find((f) => f.replayComplete === true)).toMatchObject({
        id: "r1",
        done: false,
        replay: true
      });
    });
  });

  it("an ack for a request the chat does not know sends nothing", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const sent: Array<Record<string, unknown>> = [];
      await chatDispatch(
        instance.deps,
        instance.lane,
        recordingTab("tab-x", sent),
        JSON.stringify({ type: "cf_agent_stream_resume_ack", id: "nobody" })
      );
      expect(sent).toEqual([]);
    });
  });

  it("a closed tab is forgotten: it waits for no stream and is offered none", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const release = await streamThenHold(instance, [
        { type: "start", messageId: "a1" }
      ]);
      const sent: Array<Record<string, unknown>> = [];
      await resumeChat(
        instance.deps,
        instance.lane,
        recordingTab("tab-gone", sent)
      );
      expect(offeredIn(instance.streams).get("tab-gone")).toBe("r1");
      forgetTab(instance.deps, "tab-gone");
      expect(offeredIn(instance.streams).has("tab-gone")).toBe(false);
      expect(parkedIn(instance.streams, "s1").has("tab-gone")).toBe(false);
      release();
      await instance.resultFor("r1");
    });
  });

  it("every tab is sent the message a tool answer updated, and a repeated answer sends nothing", async () => {
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
            type: "tool-pick",
            toolCallId: "c1",
            state: "input-available",
            input: {}
          }
        ]
      } as never);
      const sent: Array<Record<string, unknown>> = [];
      instance.tabs.push(recordingTab("tab-w", sent));
      const answer = {
        kind: "result" as const,
        toolCallId: "c1",
        output: { ok: true }
      };
      expect(await answerTool(instance.deps, instance.lane, answer)).toBe(true);
      expect(sent).toEqual([
        expect.objectContaining({
          type: "cf_agent_message_updated",
          message: expect.objectContaining({ id: "a1" })
        })
      ]);
      expect(await answerTool(instance.deps, instance.lane, answer)).toBe(
        false
      );
      expect(sent).toHaveLength(1);
    });
  });

  it("a tab that stops a waiting request it did not send is told it ended", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const release = await streamThenHold(instance, [
        { type: "start", messageId: "a1" }
      ]);
      // Sent by a tab that has gone; stopped by another.
      await chatDispatch(
        instance.deps,
        instance.lane,
        recordingTab("tab-gone", []),
        chatRequestWith("r2", "u2", "two")
      );
      const sent: Array<Record<string, unknown>> = [];
      const stopper = recordingTab("tab-stop", sent);
      instance.tabs.push(stopper);
      await chatDispatch(
        instance.deps,
        instance.lane,
        stopper,
        JSON.stringify({ type: "cf_agent_chat_request_cancel", id: "r2" })
      );
      expect(sent).toContainEqual(
        expect.objectContaining({ id: "r2", done: true, outcome: "aborted" })
      );
      release();
      await instance.resultFor("r2");
    });
  });

  it("a turn submitted with chat.keepStream keeps its stream, completed, after its reply is stored", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      const done = instance.nextResult();
      await submitTurn(
        instance.deps,
        instance.lane,
        { trigger: "server" },
        { requestId: "kept", metadata: { chat: { keepStream: true } } }
      );
      await done;
      expect(
        (await instance.streams.status(chatTurnStreamId("kept")))?.state
      ).toBe("completed");
      const other = instance.nextResult();
      await submitTurn(
        instance.deps,
        instance.lane,
        { trigger: "server" },
        {
          requestId: "dropped"
        }
      );
      await other;
      expect(
        await instance.streams.status(chatTurnStreamId("dropped"))
      ).toBeFalsy();
    });
  });
});
