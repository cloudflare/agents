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

/** Whether the caller already sends Access credentials. */
function authenticated(headers: Readonly<Record<string, string>>): boolean {
  return (
    "cf-access-token" in headers ||
    "cf-access-client-id" in headers ||
    /(?:^|;\s*)CF_Authorization=/.test(headers.cookie ?? "")
  );
}

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
  if (authenticated(headers)) return {};
  // Access can protect a path rather than the whole host, so probe and log
  // in to the address being opened.
  const url = new URL(socketUrl);
  url.protocol = url.protocol === "ws:" ? "http:" : "https:";
  url.search = "";
  const app = url.toString();
  if (!(await behindAccess(app, deps))) return {};

  const token = async () => {
    const { code, stdout } = await deps.run(
      "cloudflared",
      ["access", "token", `-app=${app}`],
      false
    );
    const value = stdout.trim();
    return code === 0 && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(value)
      ? value
      : undefined;
  };

  let value = await token();
  if (value === undefined) {
    deps.log(`${app} is behind Cloudflare Access; logging in.`);
    await deps.run("cloudflared", ["access", "login", app], true);
    value = await token();
  }
  if (value === undefined) {
    throw new Error(
      `Could not get a Cloudflare Access token for ${app}. Run \`cloudflared access login ${app}\`, or pass --header cf-access-token=<token>.`
    );
  }
  return { "cf-access-token": value };
}

async function behindAccess(app: string, deps: AccessDeps) {
  try {
    const response = await deps.fetch(app, { redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) {
      return false;
    }
    return new URL(location, app).hostname.endsWith(".cloudflareaccess.com");
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
