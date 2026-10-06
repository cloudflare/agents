import { describe, expect, it } from "vitest";
import { parseArgs, UsageError } from "../web/tui/args";

describe("tui args", () => {
  it("turns http(s) into ws(s) and keeps the path as given", () => {
    expect(parseArgs(["https://example.com/a/b/channels?x=1"]).url).toBe(
      "wss://example.com/a/b/channels?x=1"
    );
    expect(parseArgs(["http://localhost:5173/c"]).url).toBe(
      "ws://localhost:5173/c"
    );
    expect(parseArgs(["wss://example.com/c"]).url).toBe("wss://example.com/c");
  });

  it("drops a URL fragment, which a WebSocket URL cannot carry", () => {
    expect(parseArgs(["https://example.com/c?x=1#top"]).url).toBe(
      "wss://example.com/c?x=1"
    );
    expect(parseArgs(["https://example.com/c#top", "--as", "ann"]).url).toBe(
      "wss://example.com/c?as=ann"
    );
  });

  it("sets the participant with --as", () => {
    expect(parseArgs(["https://h/c", "--as", "ann"]).url).toBe(
      "wss://h/c?as=ann"
    );
    expect(parseArgs(["--as=bo b", "https://h/c?as=x"]).url).toBe(
      "wss://h/c?as=bo+b"
    );
  });

  it("collects headers in either form", () => {
    const { headers } = parseArgs([
      "https://h/c",
      "--header",
      "X-One=a=b",
      "-H",
      "Authorization: Bearer t:1",
      "--header=x-two=2"
    ]);
    expect(headers).toEqual({
      "x-one": "a=b",
      authorization: "Bearer t:1",
      "x-two": "2"
    });
  });

  it("sends an Access service token from the environment", () => {
    const env = { CF_ACCESS_CLIENT_ID: "id", CF_ACCESS_CLIENT_SECRET: "s" };
    expect(parseArgs(["https://h/c"], env).headers).toEqual({
      "cf-access-client-id": "id",
      "cf-access-client-secret": "s"
    });
    expect(
      parseArgs(["https://h/c", "-H", "CF-Access-Client-Id: other"], env)
        .headers["cf-access-client-id"]
    ).toBe("other");
    expect(() =>
      parseArgs(["https://h/c"], { CF_ACCESS_CLIENT_ID: "id" })
    ).toThrow(UsageError);
  });

  it("rejects bad input", () => {
    for (const argv of [
      [],
      ["not a url"],
      ["ftp://h/c"],
      ["https://h/c", "extra"],
      ["https://h/c", "--nope"],
      ["https://h/c", "--as"],
      ["https://h/c", "-H", "novalue"]
    ]) {
      expect(() => parseArgs(argv), argv.join(" ")).toThrow(UsageError);
    }
  });
});
