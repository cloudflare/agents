export const usage = `Usage: agents tui <url> [--as <participant>] [--header <name=value>]...

  <url>       The conversation's Web Channel URL, http(s) or ws(s)

Commands, when the agent supports them:
  /new             Start a new conversation and follow it
  /fork            Fork this conversation and follow the fork
  /reset [note]    Start this conversation over, with an optional handoff note
  /conversations   List the agent's conversations; ● marks the one followed
  /switch <id>     Follow another conversation (a unique id prefix is enough)

Options:
  --as        Sets the "as" query parameter (demo agents read it as the participant)
  --header    Adds a header to the WebSocket upgrade; repeatable

Cloudflare Access:
  A URL behind Access gets a token from cloudflared, which logs in through
  the browser the first time. Or set CF_ACCESS_CLIENT_ID and
  CF_ACCESS_CLIENT_SECRET to send a service token instead.`;

export type TuiArgs = {
  /** A ws(s) URL. */
  url: string;
  headers: Record<string, string>;
};

export class UsageError extends Error {}

type Env = Readonly<Record<string, string | undefined>>;

export function parseArgs(argv: readonly string[], env: Env = {}): TuiArgs {
  let raw: string | undefined;
  let as: string | undefined;
  const headers: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = splitFlag(arg);
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[++i];
      if (next === undefined) throw new UsageError(`${flag} needs a value`);
      return next;
    };
    if (flag === "--as") as = value();
    else if (flag === "--header" || flag === "-H") {
      const [name, headerValue] = parseHeader(value());
      headers[name] = headerValue;
    } else if (arg.startsWith("-")) throw new UsageError(`Unknown flag ${arg}`);
    else if (raw === undefined) raw = arg;
    else throw new UsageError(`Unexpected argument ${arg}`);
  }

  if (raw === undefined) throw new UsageError("Missing <url>");
  const url = toSocketUrl(raw);
  if (as !== undefined) url.searchParams.set("as", as);
  return {
    url: url.toString(),
    headers: { ...accessHeaders(env), ...headers }
  };
}

function splitFlag(arg: string): [string, string | undefined] {
  if (!arg.startsWith("--")) return [arg, undefined];
  const eq = arg.indexOf("=");
  return eq === -1 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)];
}

/** `name=value` or `Name: value`, split at whichever comes first. */
function parseHeader(header: string): [string, string] {
  const at = [header.indexOf("="), header.indexOf(":")]
    .filter((i) => i > 0)
    .sort((a, b) => a - b)[0];
  if (at === undefined) {
    throw new UsageError(`Header "${header}" is not name=value`);
  }
  return [
    header.slice(0, at).trim().toLowerCase(),
    header.slice(at + 1).trim()
  ];
}

function toSocketUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`"${raw}" is not a URL`);
  }
  const protocol = {
    "http:": "ws:",
    "https:": "wss:",
    "ws:": "ws:",
    "wss:": "wss:"
  }[url.protocol];
  if (!protocol) throw new UsageError(`Unsupported protocol ${url.protocol}`);
  url.protocol = protocol;
  return url;
}

function accessHeaders(env: Env): Record<string, string> {
  const id = env.CF_ACCESS_CLIENT_ID;
  const secret = env.CF_ACCESS_CLIENT_SECRET;
  if (!id && !secret) return {};
  if (!id || !secret) {
    throw new UsageError(
      "Set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET"
    );
  }
  return { "cf-access-client-id": id, "cf-access-client-secret": secret };
}
