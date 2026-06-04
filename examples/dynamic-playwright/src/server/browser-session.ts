import { DurableObject } from "cloudflare:workers";
import { closeBrowserSession, listLiveViewTargets } from "./browser-sessions";
import { runScript } from "./dynamic-runner";
import type { Env, JsonValue, LiveViewTarget } from "./types";

export class BrowserSession extends DurableObject<Env> {
  private isRunning = false;

  async run(
    scriptCode: string
  ): Promise<{ run: JsonValue; sessionId: string; targets: LiveViewTarget[] }> {
    if (this.isRunning) {
      throw new Error("Session is already running a script");
    }

    const sessionId = this.sessionId();
    this.isRunning = true;

    try {
      const response = await runScript(scriptCode, sessionId, {
        loader: this.env.LOADER,
        browser: this.env.BROWSER
      });
      const run = (await response.json()) as JsonValue;
      const targets = await listLiveViewTargets(this.env, sessionId);
      return { run, sessionId, targets };
    } finally {
      this.isRunning = false;
    }
  }

  async targets(): Promise<LiveViewTarget[]> {
    return await listLiveViewTargets(this.env, this.sessionId());
  }

  async close(): Promise<void> {
    if (this.isRunning) {
      throw new Error("Session is already running a script");
    }

    try {
      await closeBrowserSession(this.env, this.sessionId());
    } finally {
      await this.ctx.storage.deleteAll();
    }
  }

  forceUnlock(): void {
    this.isRunning = false;
  }

  debug(): { sessionId: string; isRunning: boolean } {
    return { sessionId: this.sessionId(), isRunning: this.isRunning };
  }

  private sessionId(): string {
    const name = this.ctx.id.name;
    if (!name) throw new Error("BrowserSession Durable Object requires a name");
    return name;
  }
}

export function isExpiredSessionRun(run: JsonValue): boolean {
  if (!run || typeof run !== "object") return false;
  const error = (run as Record<string, unknown>).error;
  if (typeof error !== "string") return false;
  return (
    error.includes("Session not found") ||
    error.includes("No target") ||
    error.includes("Unable to connect")
  );
}

export function browserSession(
  env: Env,
  sessionId: string
): DurableObjectStub<BrowserSession> {
  return env.BROWSER_SESSION.get(env.BROWSER_SESSION.idFromName(sessionId));
}
