import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

type Entry = { id: string; metadata: { title: string } };
type Note = { id: number; text: string };

function hubUrl(hub: string, suffix = "") {
  return `http://example.com/agents/hub-object/${hub}${suffix}`;
}

async function createEntry(hub: string, title: string): Promise<Entry> {
  const response = await exports.default.fetch(hubUrl(hub, "/catalog"), {
    method: "POST",
    body: JSON.stringify({ title })
  });
  expect(response.status).toBe(201);
  return response.json<Entry>();
}

async function listEntries(hub: string): Promise<Entry[]> {
  const response = await exports.default.fetch(hubUrl(hub, "/catalog"));
  expect(response.status).toBe(200);
  return response.json<Entry[]>();
}

/** Every target request goes through the hub's route segment. */
async function addNote(hub: string, id: string, text: string) {
  return exports.default.fetch(hubUrl(hub, `/notes/${id}/notes`), {
    method: "POST",
    body: JSON.stringify({ text })
  });
}

async function readNotes(hub: string, id: string): Promise<Note[]> {
  const response = await exports.default.fetch(
    hubUrl(hub, `/notes/${id}/notes`)
  );
  expect(response.status).toBe(200);
  return response.json<Note[]>();
}

describe("RoutedAgents on a plain Durable Object hub", () => {
  it("keeps a catalog ordered by most recent update", async () => {
    const hub = crypto.randomUUID();
    const first = await createEntry(hub, "first");
    const second = await createEntry(hub, "second");

    expect((await listEntries(hub)).map((e) => e.id)).toEqual([
      second.id,
      first.id
    ]);

    const patched = await exports.default.fetch(
      hubUrl(hub, `/catalog/${first.id}`),
      { method: "PATCH", body: JSON.stringify({ title: "renamed" }) }
    );
    expect(patched.status).toBe(200);
    expect(await listEntries(hub)).toMatchObject([
      { id: first.id, metadata: { title: "renamed" } },
      { id: second.id, metadata: { title: "second" } }
    ]);
  });

  it("forwards requests under the route to the entry's own Agent", async () => {
    const hub = crypto.randomUUID();
    const a = await createEntry(hub, "a");
    const b = await createEntry(hub, "b");

    expect((await addNote(hub, a.id, "only in a")).status).toBe(201);
    expect((await addNote(hub, b.id, "only in b")).status).toBe(201);
    expect((await addNote(hub, b.id, "also in b")).status).toBe(201);

    expect((await readNotes(hub, a.id)).map((n) => n.text)).toEqual([
      "only in a"
    ]);
    expect((await readNotes(hub, b.id)).map((n) => n.text)).toEqual([
      "only in b",
      "also in b"
    ]);

    // get(id) hands the hub a typed stub for RPC on the target.
    const detail = await exports.default.fetch(hubUrl(hub, `/catalog/${b.id}`));
    expect(await detail.json()).toMatchObject({
      entry: { id: b.id, metadata: { title: "b" } },
      notes: 2
    });
  });

  it("answers 404 for unknown entries without waking anything", async () => {
    const hub = crypto.randomUUID();
    const missing = await exports.default.fetch(
      hubUrl(hub, `/notes/${crypto.randomUUID()}/notes`)
    );
    expect(missing.status).toBe(404);

    const detail = await exports.default.fetch(
      hubUrl(hub, `/catalog/${crypto.randomUUID()}`)
    );
    expect(detail.status).toBe(404);
  });

  it("deletes an entry: hidden from the catalog and no longer routable", async () => {
    const hub = crypto.randomUUID();
    const entry = await createEntry(hub, "doomed");
    expect((await addNote(hub, entry.id, "gone soon")).status).toBe(201);

    const deleted = await exports.default.fetch(
      hubUrl(hub, `/catalog/${entry.id}`),
      { method: "DELETE" }
    );
    expect(deleted.status).toBe(200);

    expect(await listEntries(hub)).toEqual([]);
    const forwarded = await exports.default.fetch(
      hubUrl(hub, `/notes/${entry.id}/notes`)
    );
    expect(forwarded.status).toBe(404);

    const again = await exports.default.fetch(
      hubUrl(hub, `/catalog/${entry.id}`),
      { method: "DELETE" }
    );
    expect(again.status).toBe(404);
  });

  it("forwards WebSocket upgrades so the target owns the socket", async () => {
    const hub = crypto.randomUUID();
    const entry = await createEntry(hub, "live");

    const response = await exports.default.fetch(
      hubUrl(hub, `/notes/${entry.id}`),
      { headers: { Upgrade: "websocket" } }
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error("Expected a WebSocket upgrade response");
    socket.accept();

    const echoed = new Promise<string>((resolve) => {
      socket.addEventListener("message", (event) => {
        const data = String(event.data);
        // Agent sends identity and state frames on connect; wait for ours.
        if (data.startsWith("echo:")) resolve(data);
      });
    });
    socket.send("ping");
    expect(await echoed).toBe("echo:ping");

    const closed = new Promise<void>((resolve) =>
      socket.addEventListener("close", () => resolve(), { once: true })
    );
    socket.close(1000, "done");
    await closed;
  });
});
