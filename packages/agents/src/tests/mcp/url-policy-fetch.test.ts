import { describe, expect, it } from "vitest";
import { fetchWithinUrlPolicy } from "../../mcp/client/url-policy";

type Sent = { url: string; method: string; headers: Headers; body: unknown };

/** A fake network: answers each URL from `routes`, records every request. */
function fakeNetwork(routes: Record<string, () => Response>) {
  const sent: Sent[] = [];
  const fetch = async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    sent.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body
    });
    const route = routes[url];
    return route ? route() : new Response("not found", { status: 404 });
  };
  return { fetch, sent };
}

function redirect(location: string, status = 302): () => Response {
  return () => new Response(null, { status, headers: { location } });
}

describe("fetchWithinUrlPolicy", () => {
  it("refuses a private URL before sending anything", async () => {
    const net = fakeNetwork({});
    const guarded = fetchWithinUrlPolicy(net.fetch);
    for (const url of [
      "http://169.254.169.254/",
      "http://[64:ff9b::a9fe:a9fe]/",
      "http://[2002:a9fe:a9fe::]/",
      "http://metadata.internal/"
    ]) {
      await expect(guarded(url), url).rejects.toThrow("Blocked URL");
    }
    expect(net.sent).toEqual([]);
  });

  it("allows loopback for local development", async () => {
    const net = fakeNetwork({
      "http://localhost:8787/mcp": () => new Response("ok")
    });
    const response = await fetchWithinUrlPolicy(net.fetch)(
      "http://localhost:8787/mcp"
    );
    expect(await response.text()).toBe("ok");
  });

  it("refuses a redirect to a private address without following it", async () => {
    const net = fakeNetwork({
      "https://mcp.example.com/mcp": redirect("http://10.0.0.1/mcp", 307)
    });
    await expect(
      fetchWithinUrlPolicy(net.fetch)("https://mcp.example.com/mcp", {
        method: "POST",
        body: "{}"
      })
    ).rejects.toThrow("Blocked URL");
    expect(net.sent.map((s) => s.url)).toEqual(["https://mcp.example.com/mcp"]);
  });

  it("follows allowed redirects as fetch does", async () => {
    const net = fakeNetwork({
      "https://a.example.com/start": redirect(
        "https://b.example.com/next",
        302
      ),
      "https://b.example.com/next": redirect("/done", 307),
      "https://b.example.com/done": () => new Response("done")
    });
    const response = await fetchWithinUrlPolicy(net.fetch)(
      "https://a.example.com/start",
      {
        method: "POST",
        body: "{}",
        headers: {
          authorization: "Bearer t",
          "content-type": "application/json"
        }
      }
    );
    expect(await response.text()).toBe("done");
    const [first, second, third] = net.sent;
    expect(first).toMatchObject({ method: "POST", body: "{}" });
    expect(first.headers.get("authorization")).toBe("Bearer t");
    // 302 after a POST becomes a GET without a body, and another origin
    // gets no credentials.
    expect(second).toMatchObject({ method: "GET", body: undefined });
    expect(second.headers.get("authorization")).toBeNull();
    expect(second.headers.get("content-type")).toBeNull();
    // 307 keeps the method.
    expect(third).toMatchObject({
      url: "https://b.example.com/done",
      method: "GET"
    });
  });

  it("checks each request but leaves a manual redirect to the caller", async () => {
    const net = fakeNetwork({
      "https://mcp.example.com/mcp": redirect("http://10.0.0.1/mcp")
    });
    const guarded = fetchWithinUrlPolicy(net.fetch);
    const response = await guarded("https://mcp.example.com/mcp", {
      redirect: "manual"
    });
    expect(response.status).toBe(302);
    // The caller follows it with the same fetch, which refuses the hop.
    await expect(
      guarded(response.headers.get("location") ?? "", { redirect: "manual" })
    ).rejects.toThrow("Blocked URL");
    expect(net.sent).toHaveLength(1);
  });

  it("stops after 20 redirects", async () => {
    const net = fakeNetwork({
      "https://loop.example.com/": redirect("https://loop.example.com/")
    });
    await expect(
      fetchWithinUrlPolicy(net.fetch)("https://loop.example.com/")
    ).rejects.toThrow("more than 20");
    expect(net.sent).toHaveLength(21);
  });
});
