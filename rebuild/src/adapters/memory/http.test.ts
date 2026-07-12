import { describe, expect, it } from "vitest";
import { createMemoryFetch } from "./http.js";

describe("createMemoryFetch", () => {
  it("returns a scripted response for a matching route", async () => {
    const fetchLike = createMemoryFetch({
      "https://example.com/a": { status: 200, body: "hello" },
    });
    const res = await fetchLike("https://example.com/a");
    expect(res.status).toBe(200);
    expect(res.url).toBe("https://example.com/a");
    const buf = await res.arrayBuffer();
    expect(new TextDecoder().decode(buf)).toBe("hello");
  });

  it("throws for an unmatched route", async () => {
    const fetchLike = createMemoryFetch({});
    await expect(fetchLike("https://example.com/missing")).rejects.toThrow();
  });

  it("exposes scripted headers", async () => {
    const fetchLike = createMemoryFetch({
      "https://example.com/a": { status: 200, headers: { "content-type": "text/plain" } },
    });
    const res = await fetchLike("https://example.com/a");
    expect(res.headers.get("content-type")).toBe("text/plain");
  });

  it("supports scripted redirects via a 3xx status and location header", async () => {
    const fetchLike = createMemoryFetch({
      "https://example.com/from": { status: 302, headers: { location: "https://example.com/to" } },
    });
    const res = await fetchLike("https://example.com/from", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/to");
  });

  it("supports an array of sequential responses for the same route", async () => {
    const fetchLike = createMemoryFetch({
      "https://example.com/a": [
        { status: 500 },
        { status: 200, body: "ok" },
      ],
    });
    const first = await fetchLike("https://example.com/a");
    const second = await fetchLike("https://example.com/a");
    expect(first.status).toBe(500);
    expect(second.status).toBe(200);
  });

  it("supports a function route that inspects the request", async () => {
    const fetchLike = createMemoryFetch({
      "https://example.com/a": (_url, init) => ({
        status: init?.method === "POST" ? 201 : 200,
      }),
    });
    const res = await fetchLike("https://example.com/a", { method: "POST" });
    expect(res.status).toBe(201);
  });

  it("defaults body to empty when not specified", async () => {
    const fetchLike = createMemoryFetch({
      "https://example.com/a": { status: 204 },
    });
    const res = await fetchLike("https://example.com/a");
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBe(0);
  });
});
