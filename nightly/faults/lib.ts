// Driver helpers: a WebSocket chat tab, the control calls, and the shapes
// the invariants and the report read.

import type { UIMessage } from "ai";

export type Cls = "chat" | "think";

/** The deployed fault Worker, set by the suite's global setup. */
export function baseUrl(): string {
  const url = process.env.FAULTS_URL;
  if (!url) throw new Error("FAULTS_URL is not set");
  return url.replace(/\/$/, "");
}

/** The key the Worker requires on every request (`PROBE_KEY`). */
export function probeKey(): string {
  const key = process.env.FAULTS_KEY;
  if (!key) throw new Error("FAULTS_KEY is not set");
  return key;
}

export const MT = {
  MESSAGES: "cf_agent_chat_messages",
  REQUEST: "cf_agent_use_chat_request",
  RESPONSE: "cf_agent_use_chat_response",
  CANCEL: "cf_agent_chat_request_cancel",
  IDENTITY: "cf_agent_identity",
  RESUMING: "cf_agent_stream_resuming",
  RESUME_ACK: "cf_agent_stream_resume_ack",
  RESUME_REQUEST: "cf_agent_stream_resume_request",
  RESUME_NONE: "cf_agent_stream_resume_none",
  TOOL_RESULT: "cf_agent_tool_result",
  RECOVERING: "cf_agent_chat_recovering"
} as const;

export const CLIENT_TOOLS = [
  {
    name: "getUserLocation",
    description: "Get the user's current city from the client.",
    parameters: { type: "object", properties: {} }
  },
  {
    name: "getUserTimezone",
    description: "Get the user's timezone from the client.",
    parameters: { type: "object", properties: {} }
  }
];

/** A frame the server sent a tab, with the time it arrived. */
export type Frame = {
  type: string;
  id?: string;
  body?: string;
  done?: boolean;
  error?: boolean;
  continuation?: boolean;
  replay?: boolean;
  recovering?: boolean;
  outcome?: string;
  reason?: string;
  messages?: UIMessage[];
  __t: number;
};

export type ProbeEvent = {
  incidentId?: string;
  at: number;
  type: string;
  status?: string;
  reason?: string;
};
export type ProbeState = {
  messages: UIMessage[];
  schedules: number;
  events: ProbeEvent[];
  responses: {
    at: number;
    status?: string;
    continuation?: boolean;
    requestId?: string;
    error?: string;
  }[];
  calls: {
    at: number;
    step?: string;
    end?: string;
    last?: string;
    idx?: number;
  }[];
  notes: Record<string, unknown>[];
};

export const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

export function rid(prefix = "r"): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export type CtlResult = { ok: boolean; value?: unknown; error?: string };

/** Call `probe<Method>` on the room's object. */
export async function ctl(
  cls: Cls,
  room: string,
  method: string,
  ...args: unknown[]
): Promise<CtlResult> {
  try {
    const res = await fetch(`${baseUrl()}/ctl/${cls}/${room}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-probe-key": probeKey()
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(120_000)
    });
    const text = await res.text();
    try {
      return JSON.parse(text) as CtlResult;
    } catch {
      return {
        ok: false,
        error: `non-json ${res.status}: ${text.slice(0, 200)}`
      };
    }
  } catch (e) {
    return { ok: false, error: `ctl ${method} failed: ${String(e)}` };
  }
}

const AGENT_PATH: Record<Cls, string> = {
  chat: "probe-chat",
  think: "probe-think"
};

type Waiter = {
  pred: (f: Frame) => boolean | undefined;
  resolve: (f: Frame) => void;
};

/** One browser tab: a WebSocket that records every frame it receives. */
export class Tab {
  readonly frames: Frame[] = [];
  /** Ids of the requests this tab sent. */
  readonly sent: string[] = [];
  private readonly waiters: Waiter[] = [];
  private ws?: WebSocket;

  constructor(
    readonly cls: Cls,
    readonly room: string
  ) {}

  async open(): Promise<this> {
    const ws = new WebSocket(
      `${baseUrl().replace(/^http/, "ws")}/agents/${AGENT_PATH[this.cls]}/${this.room}?key=${probeKey()}`
    );
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("ws error")), {
        once: true
      });
    });
    ws.addEventListener("message", (e) => {
      let f: Frame;
      try {
        f = JSON.parse(String(e.data)) as Frame;
      } catch {
        return;
      }
      f.__t = Date.now();
      this.frames.push(f);
      // what useAgentChat does with a stream offer
      if (f.type === MT.RESUMING) this.send({ type: MT.RESUME_ACK, id: f.id });
      for (const w of [...this.waiters]) {
        if (w.pred(f)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(f);
        }
      }
    });
    return this;
  }
  send(frame: Record<string, unknown>) {
    this.ws?.send(JSON.stringify(frame));
  }
  close() {
    try {
      this.ws?.close(1000);
    } catch {
      // already closed
    }
  }
  /** Resolve on the first frame (already seen or future) that matches. */
  waitFor(
    pred: (f: Frame) => boolean | undefined,
    timeoutMs = 60_000,
    label = "frame"
  ): Promise<Frame> {
    const hit = this.frames.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w: Waiter = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          reject(new Error(`timeout waiting for ${label}`));
        }
      }, timeoutMs);
    });
  }
  request(
    id: string,
    messages: UIMessage[],
    extra: Record<string, unknown> = {}
  ): string {
    this.sent.push(id);
    this.send({
      type: MT.REQUEST,
      id,
      init: { method: "POST", body: JSON.stringify({ messages, ...extra }) }
    });
    return id;
  }
  done(id: string, timeoutMs = 90_000): Promise<Frame> {
    return this.waitFor(
      (f) => f.type === MT.RESPONSE && f.id === id && f.done === true,
      timeoutMs,
      `done ${id}`
    );
  }
}

export function user(text: string, id = rid("u")): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

export const isResp = (f: Frame) => f.type === MT.RESPONSE;

/** Roles, part types and states of a stored transcript, no model text. */
export function transcriptShape(messages: UIMessage[]): string[] {
  return messages.map((m) => {
    const parts: string[] = [];
    for (const p of m.parts) {
      let t: string;
      if (p.type === "text") t = p.text.trim() ? "text" : "text(empty)";
      else if (p.type === "step-start") t = "|";
      else if (p.type.startsWith("tool-") || p.type === "dynamic-tool") {
        const tp = p as { type: string; toolName?: string; state?: string };
        t = `${tp.type === "dynamic-tool" ? tp.toolName : tp.type.slice(5)}:${tp.state}`;
      } else t = p.type;
      if (parts.at(-1) !== t || (t !== "text" && t !== "reasoning"))
        parts.push(t);
    }
    while (parts[0] === "|") parts.shift();
    return `${m.role}[${parts.join(" ")}]`;
  });
}

export async function state(cls: Cls, room: string): Promise<ProbeState> {
  const r = await ctl(cls, room, "probeState");
  if (!r.ok) throw new Error(`probeState: ${r.error}`);
  return r.value as ProbeState;
}

const RECOVERY_ENDS = new Set([
  "chat:recovery:completed",
  "chat:recovery:exhausted",
  "chat:recovery:skipped",
  "chat:recovery:failed"
]);

/**
 * Recoveries that began and have not ended exactly once, by incident:
 * `open` never ended, `twice` ended more than once.
 */
export function recoveryBalance(events: ProbeEvent[]): {
  open: string[];
  twice: string[];
} {
  const detected = new Set<string>();
  const ends = new Map<string, number>();
  for (const e of events) {
    const id = e.incidentId ?? "?";
    if (e.type === "chat:recovery:detected") detected.add(id);
    else if (RECOVERY_ENDS.has(e.type)) ends.set(id, (ends.get(id) ?? 0) + 1);
  }
  return {
    open: [...detected].filter((id) => !ends.has(id)),
    twice: [...ends].filter(([, n]) => n > 1).map(([id]) => id)
  };
}

/**
 * Wait until the stored transcript, responses and events stop changing and
 * no recovery is open. Returns `unsettled: true` when `maxMs` runs out.
 */
export async function settle(
  cls: Cls,
  room: string,
  { quietMs = 4000, maxMs = 90_000 } = {}
): Promise<ProbeState & { unsettled: boolean }> {
  const start = Date.now();
  let last = "";
  let lastChange = Date.now();
  let s = await state(cls, room);
  while (Date.now() - start < maxMs) {
    const sig = JSON.stringify([
      transcriptShape(s.messages),
      s.responses.length,
      s.calls.length,
      s.events.length
    ]);
    const { open } = recoveryBalance(s.events);
    if (sig !== last) {
      last = sig;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= quietMs && open.length === 0) {
      return { ...s, unsettled: false };
    }
    await sleep(700);
    s = await state(cls, room);
  }
  return { ...s, unsettled: true };
}
