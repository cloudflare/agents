import type { LiveViewTarget, RunScriptResponse, Session } from "./types";

async function readJson<T>(
  response: Response,
  fallbackError: string
): Promise<T> {
  const data = (await response.json()) as T | { error?: string };
  if (!response.ok) {
    throw new Error(isErrorPayload(data) ? data.error : fallbackError);
  }
  return data as T;
}

function isErrorPayload(value: unknown): value is { error: string } {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).error === "string"
  );
}

export async function runScript(
  script: string,
  sessionId: string
): Promise<RunScriptResponse> {
  const url = new URL(`/api/sessions/${sessionId}/run`, window.location.origin);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: script
  });
  return await readJson<RunScriptResponse>(response, "Script run failed");
}

export async function createSession(): Promise<Session> {
  const response = await fetch("/api/sessions", { method: "POST" });
  const data = await readJson<{ session: Session }>(
    response,
    "Failed to create session"
  );
  return data.session;
}

export async function listSessions(): Promise<Session[]> {
  const response = await fetch("/api/sessions");
  const data = await readJson<{ sessions: Session[] }>(
    response,
    "Failed to refresh sessions"
  );
  return data.sessions;
}

export async function listSessionTargets(
  sessionId: string
): Promise<LiveViewTarget[]> {
  const response = await fetch(`/api/sessions/${sessionId}/targets`);
  const data = await readJson<{ targets: LiveViewTarget[] }>(
    response,
    "Failed to refresh targets"
  );
  return data.targets;
}

export async function stopSession(sessionId: string): Promise<Session[]> {
  const response = await fetch(`/api/sessions/${sessionId}`, {
    method: "DELETE"
  });
  const data = await readJson<{ sessions: Session[] }>(
    response,
    "Failed to stop session"
  );
  return data.sessions;
}
