import { describe, expect, it } from "vitest";
import { accessHeaders, type AccessDeps } from "../web/tui/access";

const TOKEN = "aaa.bbb.ccc";
const LOGIN = "https://team.cloudflareaccess.com/cdn-cgi/access/login/app";

function deps(options: {
  location?: string;
  tokens?: (string | undefined)[];
  missing?: boolean;
}) {
  const calls: { url?: string; command?: string[] }[] = [];
  const tokens = [...(options.tokens ?? [])];
  const value: AccessDeps = {
    fetch: async (url) => {
      calls.push({ url });
      return options.location
        ? new Response(null, {
            status: 302,
            headers: { location: options.location }
          })
        : new Response("ok");
    },
    runSync: (command, args) => {
      calls.push({ command: [command, ...args] });
      const token = tokens.shift();
      return token
        ? { code: 0, stdout: `${token}\n` }
        : { code: 1, stdout: "" };
    },
    run: async (command, args) => {
      calls.push({ command: [command, ...args] });
      if (options.missing) throw new Error("Install cloudflared");
      if (args[1] === "login") return { code: 0, stdout: "" };
      const token = tokens.shift();
      return token
        ? { code: 0, stdout: `${token}\n` }
        : { code: 1, stdout: "" };
    },
    log: () => {}
  };
  return { value, calls };
}

describe("tui Access", () => {
  it("sends nothing to a URL that is not behind Access", async () => {
    const { value, calls } = deps({});
    expect((await accessHeaders("wss://h/channels/r", {}, value))()).toEqual(
      {}
    );
    expect(calls).toEqual([{ url: "https://h/channels/r" }]);
  });

  it("gets a token from cloudflared for the address being opened", async () => {
    const { value, calls } = deps({ location: LOGIN, tokens: [TOKEN] });
    expect(
      (await accessHeaders("wss://h/channels/r?as=a", {}, value))()
    ).toEqual({
      "cf-access-token": TOKEN
    });
    expect(calls[1]).toEqual({
      command: ["cloudflared", "access", "token", "-app=https://h/channels/r"]
    });
  });

  it("logs in when there is no token yet", async () => {
    const { value, calls } = deps({
      location: LOGIN,
      tokens: [undefined, TOKEN]
    });
    expect((await accessHeaders("wss://h/c", {}, value))()).toEqual({
      "cf-access-token": TOKEN
    });
    expect(calls.map((call) => call.command?.[2])).toEqual([
      undefined,
      "token",
      "login",
      "token"
    ]);
  });

  it("leaves credentials the caller sends alone", async () => {
    const { value, calls } = deps({ location: LOGIN, tokens: [TOKEN] });
    expect(
      (
        await accessHeaders("wss://h/c", { "cf-access-client-id": "id" }, value)
      )()
    ).toEqual({});
    expect(calls).toEqual([]);
  });

  it("probes the channel path, which Access may protect alone", async () => {
    const { value, calls } = deps({ location: LOGIN, tokens: [TOKEN] });
    await accessHeaders("wss://h/channels/team/one", {}, value);
    expect(calls[0]).toEqual({ url: "https://h/channels/team/one" });
  });

  it("still logs in when the caller's cookie is not Access's", async () => {
    const { value } = deps({ location: LOGIN, tokens: [TOKEN] });
    expect(
      (await accessHeaders("wss://h/c", { cookie: "theme=dark" }, value))()
    ).toEqual({ "cf-access-token": TOKEN });
    expect(
      (
        await accessHeaders(
          "wss://h/c",
          { cookie: "theme=dark; CF_Authorization=x" },
          value
        )
      )()
    ).toEqual({});
  });

  it("ignores redirects that are not to Access", async () => {
    const { value } = deps({ location: "https://h/login" });
    expect((await accessHeaders("wss://h/c", {}, value))()).toEqual({});
  });

  it("explains how to continue when cloudflared is missing", async () => {
    const { value } = deps({ location: LOGIN, missing: true });
    await expect(accessHeaders("wss://h/c", {}, value)).rejects.toThrow(
      "Install cloudflared"
    );
  });

  it("gets a fresh token, without logging in, each time headers are read", async () => {
    const { value, calls } = deps({
      location: LOGIN,
      tokens: [TOKEN, "ddd.eee.fff", undefined]
    });
    const headers = await accessHeaders("wss://h/c", {}, value);
    expect(headers()).toEqual({ "cf-access-token": TOKEN });
    expect(headers()).toEqual({ "cf-access-token": "ddd.eee.fff" });
    // A failed refresh keeps the last token; the upgrade reports the rest.
    expect(headers()).toEqual({ "cf-access-token": "ddd.eee.fff" });
    expect(calls.filter((call) => call.command?.[2] === "login")).toEqual([]);
  });
});
