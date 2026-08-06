export type RlmRequest = {
  requestId: string;
  status: "admitted" | "running" | "completed" | "error";
  inputId: string;
  answer?: string;
  error?: string;
};

export type HistoryMessage = {
  id: number;
  scope: string;
  role: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: number;
};

export class RlmApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

async function decode<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  if (!response.ok) {
    throw new RlmApiError(
      typeof body?.error === "string"
        ? body.error
        : `request failed with HTTP ${response.status}`,
      response.status
    );
  }
  return body as T;
}

export function createRlmApi(session: string, token: string) {
  const base = `/sessions/${encodeURIComponent(session)}`;
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (init?.body) headers.set("content-type", "application/json");
    return decode<T>(
      await fetch(`${base}${path}`, { ...init, headers, cache: "no-store" })
    );
  }
  return {
    async history(signal?: AbortSignal): Promise<HistoryMessage[]> {
      return (
        await request<{ messages: HistoryMessage[] }>("/history?limit=50", {
          signal
        })
      ).messages;
    },
    submit(
      requestId: string,
      task: string,
      context: string,
      signal?: AbortSignal
    ): Promise<RlmRequest> {
      return request("/think", {
        method: "POST",
        body: JSON.stringify({ requestId, task, ...(context && { context }) }),
        signal
      });
    },
    status(requestId: string, signal?: AbortSignal): Promise<RlmRequest> {
      return request(`/requests?requestId=${encodeURIComponent(requestId)}`, {
        signal
      });
    }
  };
}
