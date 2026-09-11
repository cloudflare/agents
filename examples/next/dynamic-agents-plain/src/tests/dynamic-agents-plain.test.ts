import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

function workspaceUrl(name: string, tail = ""): string {
  return `https://example.com/agents/workspace/${name}${tail}`;
}

function notebookUrl(workspace: string, notebook: string, tail = ""): string {
  return workspaceUrl(workspace, `/sub/notebook/${notebook}${tail}`);
}

async function call(url: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(url, init));
}

async function nextFrame(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    socket.addEventListener(
      "message",
      (event) => resolve(JSON.parse(String(event.data))),
      { once: true }
    );
  });
}

describe("dynamic agents on a plain Durable Object", () => {
  it("creates notebooks with isolated storage and forwards HTTP to them", async () => {
    const workspace = `ws-${crypto.randomUUID()}`;
    const created = await call(workspaceUrl(workspace, "/notebooks/todo"), {
      method: "POST"
    });
    expect(created.status).toBe(201);

    const added = await call(notebookUrl(workspace, "todo", "/notes"), {
      method: "POST",
      body: JSON.stringify({ text: "buy milk" })
    });
    expect(added.status).toBe(201);

    const listed = (await (
      await call(notebookUrl(workspace, "todo"))
    ).json()) as {
      notebook: string;
      workspace: string;
      notes: Array<{ text: string }>;
    };
    expect(listed.notebook).toBe("todo");
    expect(listed.workspace).toBe(workspace);
    expect(listed.notes.map((note) => note.text)).toEqual(["buy milk"]);

    const index = (await (await call(workspaceUrl(workspace))).json()) as {
      notebooks: string[];
    };
    expect(index.notebooks).toEqual(["todo"]);
  });

  it("refuses notebooks the workspace never created", async () => {
    const workspace = `ws-${crypto.randomUUID()}`;
    const response = await call(notebookUrl(workspace, "ghost"));
    expect(response.status).toBe(404);
  });

  it("bridges WebSockets into the notebook and broadcasts new notes", async () => {
    const workspace = `ws-${crypto.randomUUID()}`;
    await call(workspaceUrl(workspace, "/notebooks/chat"), { method: "POST" });

    const open = async () => {
      const response = await call(notebookUrl(workspace, "chat"), {
        headers: { Upgrade: "websocket" }
      });
      expect(response.status).toBe(101);
      const socket = response.webSocket as WebSocket;
      socket.accept();
      expect(await nextFrame(socket)).toEqual({
        type: "hello",
        notebook: "chat"
      });
      return socket;
    };
    const first = await open();
    const second = await open();

    const seen = Promise.all([nextFrame(first), nextFrame(second)]);
    first.send("note:hello everyone");
    const frames = (await seen) as Array<{
      type: string;
      note: { text: string };
    }>;
    expect(frames.map((frame) => frame.note.text)).toEqual([
      "hello everyone",
      "hello everyone"
    ]);

    const listed = (await (
      await call(notebookUrl(workspace, "chat"))
    ).json()) as {
      notes: Array<{ text: string }>;
    };
    expect(listed.notes.map((note) => note.text)).toEqual(["hello everyone"]);
    first.close(1000, "done");
    second.close(1000, "done");
  });

  it("abort keeps notes; delete wipes them", async () => {
    const workspace = `ws-${crypto.randomUUID()}`;
    await call(workspaceUrl(workspace, "/notebooks/draft"), { method: "POST" });
    await call(notebookUrl(workspace, "draft", "/notes"), {
      method: "POST",
      body: JSON.stringify({ text: "keep me" })
    });

    await call(workspaceUrl(workspace, "/notebooks/draft/abort"), {
      method: "POST"
    });
    let listed = (await (
      await call(notebookUrl(workspace, "draft"))
    ).json()) as {
      notes: Array<{ text: string }>;
    };
    expect(listed.notes.map((note) => note.text)).toEqual(["keep me"]);

    await call(workspaceUrl(workspace, "/notebooks/draft"), {
      method: "DELETE"
    });
    expect((await call(notebookUrl(workspace, "draft"))).status).toBe(404);

    await call(workspaceUrl(workspace, "/notebooks/draft"), { method: "POST" });
    listed = (await (await call(notebookUrl(workspace, "draft"))).json()) as {
      notes: Array<{ text: string }>;
    };
    expect(listed.notes).toEqual([]);
  });
});
