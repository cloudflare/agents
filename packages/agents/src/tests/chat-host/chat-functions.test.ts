import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Connection } from "agents";
import type { ChatTurnHostObject } from "../capabilities/chat-turn";
import {
  type ChatLane,
  answerTool,
  chatDispatch,
  connectChat,
  resumeChat,
  submitTurn
} from "../../chat/chat-functions";
import { parkedIn } from "../../chat/chat-host";

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
      const answered = answerTool(instance.deps, instance.lane, {
        kind: "result",
        toolCallId: "c1",
        output: { ok: true }
      });
      const sent: Array<Record<string, unknown>> = [];
      await resumeChat(
        instance.deps,
        instance.lane,
        recordingTab("tab-a", sent),
        "p2"
      );
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

  it("an answer to a call in an older reply continues that reply, not the latest", async () => {
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
      const done = instance.nextResult();
      await answerTool(
        instance.deps,
        instance.lane,
        { kind: "result", toolCallId: "c1", output: { ok: true } },
        { autoContinue: true }
      );
      await done;
      expect(instance.calls[0]).toMatchObject({
        mode: "continue",
        replyId: "a1"
      });
      expect(instance.calls[0].messages.map((m) => m.id)).toEqual(["u1", "a1"]);
      expect(await session.getMessage("a2")).toMatchObject({
        parts: [{ type: "text", text: "Latest" }]
      });
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
      const answered = answerTool(
        instance.deps,
        instance.lane,
        { kind: "result", toolCallId: "c1", output: { ok: true } },
        { autoContinue: true }
      );
      const sent: Array<Record<string, unknown>> = [];
      await resumeChat(
        instance.deps,
        instance.lane,
        recordingTab("tab-h", sent),
        "p3"
      );
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
      const deps = {
        ...instance.deps,
        webSockets: {
          getConnections: () => [recordingTab("tab-x", sent)]
        } as never
      };
      const lane = { ...instance.lane, arrival: "drop" as const };
      const finish = await holdFirstTurn(instance, lane);
      await chatDispatch(deps, lane, tab, chatRequestWith("r2", "u2", "two"));
      await finish();
      expect(instance.calls.map((c) => c.requestId)).toEqual(["r1"]);
      expect(await instance.sessions.session("s1").getMessage("u2")).toBeNull();
      expect(sent).toContainEqual(
        expect.objectContaining({ id: "r2", done: true, outcome: "skipped" })
      );
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

  it("a connecting tab is sent the transcript", async () => {
    const stub = env.ChatTurnHostObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: ChatTurnHostObject) => {
      await instance.lifecycle.start();
      await instance.sessions.session("s1").appendMessage({
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "Hi" }]
      } as never);
      const sent: Array<Record<string, unknown>> = [];
      await connectChat(instance.deps, {
        id: "tab-3",
        readyState: 1,
        send: (text: string) => sent.push(JSON.parse(text))
      } as unknown as Connection);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ type: "cf_agent_chat_messages" });
      expect(
        (sent[0].messages as Array<{ id: string }>).map((m) => m.id)
      ).toEqual(["u1"]);
    });
  });
});
