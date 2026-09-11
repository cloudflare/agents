import { describe, expect, it } from "vitest";
import {
  childUrl,
  connect,
  grandchildUrl,
  parentStub,
  parentUrl,
  tryConnect,
  waitFor
} from "./helpers";

/**
 * A child's sockets live on the parent and are bridged into the child's
 * WebSockets capability: handlers, connection state, tags, broadcasts,
 * closes, and rehydration all flow through the DynamicAgents route.
 */
describe("DynamicAgents WebSocket forwarding", () => {
  it("connects to a child through the parent and echoes", async () => {
    const name = crypto.randomUUID();
    const client = await connect(childUrl(name, "n1", "/room?stamp=1"));

    expect(await client.next()).toBe("child:n1:/room:parent");
    client.socket.send("echo:hi");
    expect(await client.next()).toBe("echo:hi:n1");

    const parent = parentStub(name);
    // The parent's WebSockets never sees the child's socket; the platform does.
    expect(await parent.connectionIds()).toEqual([]);
    expect((await parent.socketIds()).length).toBe(1);
    // The child sees it, with the tags its own capability computed.
    const [id] = await parent.socketIds();
    expect(await parent.childConnectionIds("n1")).toEqual([id]);
    expect(await parent.childConnectionIds("n1", "child-tag")).toEqual([id]);
    client.socket.send("who");
    expect(await client.next()).toBe(`who:${id}:${id},child-tag`);
  });

  it("keeps the parent's own sockets separate from its children's", async () => {
    const name = crypto.randomUUID();
    const own = await connect(parentUrl(name));
    expect(await own.next()).toBe(`parent:${name}`);
    const child = await connect(childUrl(name, "n1"));
    await child.next();

    const parent = parentStub(name);
    expect((await parent.connectionIds()).length).toBe(1);
    expect((await parent.socketIds()).length).toBe(2);
    own.socket.send("x");
    expect(await own.next()).toBe("parent-echo:x");
  });

  it("scopes a child's broadcast to that child's connections", async () => {
    const name = crypto.randomUUID();
    const a1 = await connect(childUrl(name, "a"));
    const a2 = await connect(childUrl(name, "a"));
    const b = await connect(childUrl(name, "b"));
    await Promise.all([a1.next(), a2.next(), b.next()]);

    a1.socket.send("broadcast:hello");
    expect(await a1.next()).toBe("broadcast:hello");
    expect(await a2.next()).toBe("broadcast:hello");

    // From outside any frame: routed to the root as a broadcast message.
    await parentStub(name).childBroadcast("b", "later");
    expect(await b.next()).toBe("later");
    // `a`'s clients never see `b`'s broadcast; the next frame they get is
    // their own echo.
    a1.socket.send("echo:still-a");
    expect(await a1.next()).toBe("echo:still-a:a");
  });

  it("persists connection state on the parent and rehydrates it", async () => {
    const name = crypto.randomUUID();
    const client = await connect(childUrl(name, "n1"));
    await client.next();
    client.socket.send('state:{"draft":"x"}');
    expect(await client.next()).toBe('state:{"draft":"x"}');

    const parent = parentStub(name);
    const [id] = await parent.socketIds();
    expect(await parent.childRehydrate("n1")).toEqual([id]);
    client.socket.send("state?");
    expect(await client.next()).toBe('state:{"draft":"x"}');
    client.socket.send("who");
    expect(await client.next()).toBe(`who:${id}:${id},child-tag`);
  });

  it("closes from either side and runs the child's onClose", async () => {
    const name = crypto.randomUUID();
    const byChild = await connect(childUrl(name, "n1"));
    await byChild.next();
    byChild.socket.send("close");
    expect(await byChild.closed).toEqual({
      code: 4000,
      reason: "closed by child"
    });

    const byClient = await connect(childUrl(name, "n1"));
    await byClient.next();
    byClient.close(1000, "bye");
    await byClient.closed;
    await waitFor(
      () => parentStub(name).childConnectionIds("n1"),
      (ids) => ids.length === 0
    );
  });

  it("gates upgrades before accepting the socket", async () => {
    const name = crypto.randomUUID();
    await parentStub(name).denyChild("locked");
    const { response } = await tryConnect(childUrl(name, "locked"));
    expect(response.status).toBe(403);
    expect(await parentStub(name).socketIds()).toEqual([]);
  });

  it("forwards a connection two hops down and reports a missing WebSockets capability", async () => {
    const name = crypto.randomUUID();
    // The grandchild installs no WebSockets: the upgrade surfaces the error.
    const { response, open } = await tryConnect(grandchildUrl(name, "c", "g"));
    expect(response.status).toBe(101);
    const frame = await open!.next();
    expect(frame).toContain("no WebSockets capability");
  });

  it("still serves sockets accepted by the previous release", async () => {
    const name = crypto.randomUUID();
    const outer = encodeURIComponent(childUrl(name, "legacy"));
    const client = await connect(
      parentUrl(name, `/legacy/socket?outer=${outer}`)
    );
    client.socket.send("echo:old");
    expect(await client.next()).toBe("echo:old:legacy");

    const parent = parentStub(name);
    // WebSockets enumerates the legacy socket, but the parent's view of its
    // own connections must skip it.
    expect(await parent.connectionIds()).toEqual([]);
    const [id] = await parent.socketIds();
    expect(await parent.childConnectionIds("legacy")).toEqual([id]);
    client.socket.send('state:{"kept":true}');
    expect(await client.next()).toBe('state:{"kept":true}');
    expect(await parent.childRehydrate("legacy")).toEqual([id]);
    client.socket.send("state?");
    expect(await client.next()).toBe('state:{"kept":true}');
  });
});
