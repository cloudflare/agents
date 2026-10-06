import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { accessHeaders, type AccessDeps } from "../web/tui/access";
import { parseArgs, UsageError } from "../web/tui/args";
import { parseRpcMessage } from "./protocol";

export const usage = `Usage: agents acp <url> [--as <participant>] [--header <name=value>]...

Connects an Agent Client Protocol client, such as Zed or T3 Code, to an
agent's ACP channel. The client launches this command as its agent: it reads
JSON-RPC from stdin and writes it to stdout, one message per line, and logs
to stderr.

  <url>       The agent's ACP channel URL, http(s) or ws(s)

Options:
  --as        Sets the "as" query parameter (demo agents read it as the participant)
  --header    Adds a header to the WebSocket upgrade; repeatable

Cloudflare Access:
  A URL behind Access gets a token from cloudflared. Log in once with
  \`cloudflared access login <url>\`, or set CF_ACCESS_CLIENT_ID and
  CF_ACCESS_CLIENT_SECRET to send a service token instead.`;

/** Runs `agents acp`; resolves with the exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.error(usage);
    return 0;
  }
  let args;
  try {
    args = parseArgs(argv, process.env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    log(`${error.message}\n\n${usage}`);
    return 2;
  }
  let headers = args.headers;
  try {
    headers = { ...headers, ...(await accessHeaders(args.url, headers, deps)) };
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return 1;
  }
  return bridge(args.url, headers);
}

/**
 * Pipe stdin to the socket and the socket to stdout. Only JSON-RPC reaches
 * stdout: the socket can also carry the agent's own frames, such as its
 * identity, which an ACP client would reject.
 */
function bridge(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    // SAFETY: Node's (undici's) WebSocket takes `{ headers }` in place of
    // the protocols argument.
    const NodeWebSocket = globalThis.WebSocket as unknown as new (
      url: string,
      init: { headers: Record<string, string> }
    ) => WebSocket;
    const socket = new NodeWebSocket(url, { headers });
    const queued: string[] = [];
    let stdinClosed = false;

    socket.addEventListener("open", () => {
      log(`connected to ${url}`);
      for (const line of queued.splice(0)) socket.send(line);
      if (stdinClosed) socket.close(1000, "stdin closed");
    });
    socket.addEventListener("message", (event) => {
      const data: unknown = event.data;
      const text =
        typeof data === "string"
          ? data
          : Buffer.from(data as ArrayBuffer).toString("utf8");
      const message = parseRpcMessage(text);
      // Serialized again so each message is one line.
      if (message) process.stdout.write(`${JSON.stringify(message)}\n`);
    });
    socket.addEventListener("error", () => log("socket error"));
    socket.addEventListener("close", (event) => {
      log(
        `disconnected (${event.code}${event.reason ? ` ${event.reason}` : ""})`
      );
      resolve(stdinClosed && event.code === 1000 ? 0 : 1);
    });

    const input = createInterface({
      input: process.stdin,
      crlfDelay: Infinity
    });
    input.on("line", (line) => {
      if (!line.trim()) return;
      if (socket.readyState === WebSocket.OPEN) socket.send(line);
      else queued.push(line);
    });
    input.on("close", () => {
      stdinClosed = true;
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1000, "stdin closed");
      } else if (socket.readyState !== WebSocket.CONNECTING) {
        resolve(0);
      }
    });
  });
}

function log(message: string): void {
  process.stderr.write(`[agents acp] ${message}\n`);
}

/** Access lookups that keep stdout for the protocol. */
const deps: AccessDeps = {
  fetch: (url, init) => fetch(url, init),
  run: (command, args, interactive) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        // A login may print; it goes to stderr, never stdout.
        stdio: interactive ? ["ignore", 2, 2] : ["ignore", "pipe", "ignore"]
      });
      let stdout = "";
      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        reject(
          error.code === "ENOENT"
            ? new Error(
                "This URL is behind Cloudflare Access. Install cloudflared, or pass --header cf-access-token=<token>."
              )
            : error
        );
      });
      child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
    }),
  log
};
