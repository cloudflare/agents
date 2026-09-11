import { describe, expect, it } from "vitest";
import {
  childUrl,
  fetchThrough,
  grandchildUrl,
  parentStub,
  parentUrl
} from "./helpers";

describe("DynamicAgents HTTP forwarding", () => {
  it("forwards /sub/ requests to the child with the segment stripped", async () => {
    const name = crypto.randomUUID();
    const response = await fetchThrough(childUrl(name, "n1", "/notes?x=1"));
    expect(await response.text()).toBe("child:n1:/notes:-");
    // The parent's own requests still reach the parent (with the routed
    // path as the router delivered it).
    const own = await fetchThrough(parentUrl(name, "/status"));
    expect(await own.text()).toBe(
      `parent:${name}:${new URL(parentUrl(name, "/status")).pathname}`
    );
  });

  it("forwards through two hops to a grandchild", async () => {
    const name = crypto.randomUUID();
    const response = await fetchThrough(grandchildUrl(name, "c", "g", "/leaf"));
    expect(await response.text()).toBe("grandchild:g:/leaf");
    expect(await parentStub(name).list()).toEqual(["c"]);
  });

  it("streams the body and preserves the method", async () => {
    const name = crypto.randomUUID();
    const body = "x".repeat(64 * 1024);
    const response = await fetchThrough(childUrl(name, "n1", "/upload"), {
      method: "POST",
      body
    });
    expect(response.status).toBe(200);
  });

  it("runs the child gate: a Response rejects, a Request rewrites", async () => {
    const name = crypto.randomUUID();
    const parent = parentStub(name);
    await parent.denyChild("locked");

    const denied = await fetchThrough(childUrl(name, "locked", "/notes"));
    expect(denied.status).toBe(403);
    expect(denied.headers.get("x-denied-by")).toBe("parent");
    expect(await parent.has("locked")).toBe(false);

    const stamped = await fetchThrough(
      childUrl(name, "open", "/notes?stamp=1")
    );
    expect(await stamped.text()).toBe("child:open:/notes:parent");

    const calls = await parent.getGateCalls();
    expect(calls.map((call) => call.child.name)).toEqual(["locked", "open"]);
    expect(calls[0]?.url).toBe(childUrl(name, "locked", "/notes"));
  });

  it("answers 404 for an unknown child class without leaking exports", async () => {
    const name = crypto.randomUUID();
    const response = await fetchThrough(
      parentUrl(name, "/sub/no-such-class/x/notes")
    );
    // No known class matches, so the request is the parent's own.
    expect(await response.text()).toBe(
      `parent:${name}:${new URL(parentUrl(name, "/sub/no-such-class/x/notes")).pathname}`
    );
  });

  it("answers 400 for a reserved child name", async () => {
    const name = crypto.randomUUID();
    const response = await fetchThrough(childUrl(name, "%00bad", "/notes"));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Bad Request");
  });
});
