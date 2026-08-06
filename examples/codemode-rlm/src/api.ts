export type ActiveRequestStatus = "admitted" | "running";
export type RequestStatus = ActiveRequestStatus | "completed" | "error";

export type RlmRequest = {
  requestId: string;
  kind: "think" | "refine";
  status: RequestStatus;
  inputId: string;
  answer?: string;
  error?: string;
  executionIds?: string[];
  recursiveCalls?: number;
};

export type HistoryMessage = {
  id: number;
  scope: string;
  role: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: number;
};

export type SessionSummary = {
  kind: string;
  model: string;
  orchestration: string;
  modelFacingTools: string[];
  limits: {
    maxSteps: number;
    maxDepth: number;
    maxRlmCalls: number;
    maxParallel: number;
    timeoutMs: number;
  };
  messages: number;
  children: number;
  harness: { revision?: number; entries?: number } & Record<string, unknown>;
};

export type ChildRecord = {
  id: string;
  name: string;
  mode: string;
  status: string;
  answer?: string;
  error?: string;
  updatedAt: number;
};

export type ExecutionRecord = {
  id: string;
  status: string;
  createdAt: number;
  updatedAt: number;
};

export class RlmApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "RlmApiError";
  }
}

async function decode<T>(response: Response): Promise<T> {
  const value = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  if (!response.ok) {
    const message =
      typeof value?.error === "string"
        ? value.error
        : `request failed with HTTP ${response.status}`;
    throw new RlmApiError(message, response.status);
  }
  return value as T;
}

export class RlmApi {
  readonly #base: string;

  constructor(
    session: string,
    readonly token: string
  ) {
    this.#base = `/sessions/${encodeURIComponent(session)}`;
  }

  async #request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    if (init?.body) headers.set("content-type", "application/json");
    return decode<T>(
      await fetch(`${this.#base}${path}`, {
        ...init,
        headers,
        cache: "no-store"
      })
    );
  }

  summary(): Promise<SessionSummary> {
    return this.#request("");
  }

  async history(limit = 50): Promise<HistoryMessage[]> {
    const result = await this.#request<{ messages: HistoryMessage[] }>(
      `/history?limit=${limit}`
    );
    return result.messages;
  }

  submit(
    requestId: string,
    task: string,
    context: string
  ): Promise<RlmRequest> {
    return this.#request("/think", {
      method: "POST",
      body: JSON.stringify({
        requestId,
        task,
        ...(context ? { context } : {})
      })
    });
  }

  request(requestId: string): Promise<RlmRequest> {
    return this.#request(
      `/requests?requestId=${encodeURIComponent(requestId)}`
    );
  }

  async children(): Promise<ChildRecord[]> {
    const result = await this.#request<{ children: ChildRecord[] }>(
      "/children?limit=20"
    );
    return result.children;
  }

  async executions(): Promise<ExecutionRecord[]> {
    const result = await this.#request<{ executions: ExecutionRecord[] }>(
      "/executions?limit=20"
    );
    return result.executions;
  }
}
