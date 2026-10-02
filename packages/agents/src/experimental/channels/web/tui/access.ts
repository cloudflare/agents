import { spawn } from "node:child_process";

/** What finding an Access token needs, replaceable in tests. */
export type AccessDeps = {
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** Runs a command; `interactive` lets it use the terminal. */
  run(
    command: string,
    args: readonly string[],
    interactive: boolean
  ): Promise<{ code: number; stdout: string }>;
  log(message: string): void;
};

/** Headers that already authenticate to Access. */
const CREDENTIALS = ["cf-access-token", "cf-access-client-id", "cookie"];

/**
 * The `cf-access-token` header for a URL behind Cloudflare Access, from
 * `cloudflared`. Logs in through the browser when there is no token yet.
 * Returns no headers when the caller already sends credentials, or when the
 * URL is not behind Access.
 */
export async function accessHeaders(
  socketUrl: string,
  headers: Readonly<Record<string, string>>,
  deps: AccessDeps = nodeDeps
): Promise<Record<string, string>> {
  if (CREDENTIALS.some((name) => name in headers)) return {};
  const url = new URL(socketUrl);
  url.protocol = url.protocol === "ws:" ? "http:" : "https:";
  const origin = url.origin;
  if (!(await behindAccess(origin, deps))) return {};

  const token = async () => {
    const { code, stdout } = await deps.run(
      "cloudflared",
      ["access", "token", `-app=${origin}`],
      false
    );
    const value = stdout.trim();
    return code === 0 && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(value)
      ? value
      : undefined;
  };

  let value = await token();
  if (value === undefined) {
    deps.log(`${origin} is behind Cloudflare Access; logging in.`);
    await deps.run("cloudflared", ["access", "login", origin], true);
    value = await token();
  }
  if (value === undefined) {
    throw new Error(
      `Could not get a Cloudflare Access token for ${origin}. Run \`cloudflared access login ${origin}\`, or pass --header cf-access-token=<token>.`
    );
  }
  return { "cf-access-token": value };
}

async function behindAccess(origin: string, deps: AccessDeps) {
  try {
    const response = await deps.fetch(origin, { redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) {
      return false;
    }
    return new URL(location, origin).hostname.endsWith(".cloudflareaccess.com");
  } catch {
    // Unreachable: let the WebSocket report it.
    return false;
  }
}

const nodeDeps: AccessDeps = {
  fetch: (url, init) => fetch(url, init),
  run: (command, args, interactive) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: interactive ? "inherit" : ["ignore", "pipe", "ignore"]
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
  log: (message) => console.error(message)
};
