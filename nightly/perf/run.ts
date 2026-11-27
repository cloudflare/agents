// The perf scenarios (from the perf agent's probe): each runs on fresh rooms
// of the perf Worker and returns what the object counted.

/** One scenario's counts, time and what it left at rest, as the Worker reports them. */
export type Result = {
  ok?: boolean;
  error?: string;
  counts?: Record<string, number>;
  databaseSize?: number;
  tables?: { table: string; rows: number; bytes: number }[];
  jobs?: unknown[];
  facet?: Result;
  driverMs?: number;
  [key: string]: unknown;
};

/** Run the scenarios whose `<class>/<name>` key `only` accepts (all by default). */
export async function runScenarios(
  base: string,
  only?: (key: string) => boolean
): Promise<Record<string, Result>> {
  // same-length room names in every run, so stored bytes compare
  const tag = Math.random().toString(16).slice(2, 10);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // A scenario the build cannot finish fails its row instead of hanging the run.
  async function call(path: string): Promise<Result> {
    let text: string;
    try {
      const res = await fetch(base + path, {
        signal: AbortSignal.timeout(120_000)
      });
      text = await res.text();
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 300) };
    }
    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, error: text.slice(0, 300) };
    }
  }
  const run = (
    cls: string,
    room: string,
    sc: string,
    arg?: string | number,
    reset = true
  ) =>
    call(
      `/run/${cls}/${room}/${sc}${arg != null || !reset ? "?" : ""}${arg != null ? `arg=${encodeURIComponent(arg)}` : ""}${!reset ? `${arg != null ? "&" : ""}reset=0` : ""}`
    );
  const since = (cls: string, room: string) => call(`/since/${cls}/${room}`);
  const abort = (cls: string, room: string) => call(`/abort/${cls}/${room}`);
  /** Until the room has a reply streaming (bounded at 10 s). */
  async function streaming(cls: string, room: string) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if ((await call(`/streaming/${cls}/${room}`)).streaming === true) return;
      await sleep(20);
    }
    throw new Error("no reply started streaming within 10 s");
  }

  function wsUrl(cls: string, room: string) {
    const u = new URL(base);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = `/agents/perf-${cls}/${room}`;
    return u.toString();
  }
  async function connect(cls: string, room: string, holdMs = 1000) {
    const ws = new WebSocket(wsUrl(cls, room));
    let frames = 0;
    let bytes = 0;
    ws.onmessage = (e: MessageEvent) => {
      frames++;
      // Take a stream the server offers, as useAgentChat does, so a
      // reconnect mid-stream measures the replay too.
      if (
        typeof e.data === "string" &&
        e.data.includes('"cf_agent_stream_resuming"')
      ) {
        const { id } = JSON.parse(e.data) as { id?: string };
        ws.send(JSON.stringify({ type: "cf_agent_stream_resume_ack", id }));
      }
      bytes +=
        typeof e.data === "string"
          ? e.data.length
          : ((e.data as ArrayBuffer).byteLength ?? 0);
    };
    await new Promise<void>((res, rej) => {
      const timer = setTimeout(() => {
        ws.close();
        rej(new Error("WebSocket did not open within 30 s"));
      }, 30_000);
      ws.onopen = () => {
        clearTimeout(timer);
        res();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        rej(new Error("ws error"));
      };
    });
    await sleep(holdMs);
    ws.close();
    return { frames, bytes };
  }

  const chatHosts = ["think", "chat"];
  const scenarios: {
    name: string;
    cls: string;
    fn: (room: string) => Promise<Result>;
  }[] = [];
  const add = (
    name: string,
    cls: string,
    fn: (room: string) => Promise<Result>
  ) => scenarios.push({ name, cls, fn });

  for (const cls of chatHosts) {
    add("startup-empty", cls, async (room) => since(cls, room));
    add("startup-500", cls, async (room) => {
      const seeded = await run(cls, room, "seed", 500);
      if (seeded.ok === false) return seeded;
      await abort(cls, room);
      return since(cls, room);
    });
    add("turn-short", cls, async (room) => {
      await run(cls, room, "noop");
      return run(cls, room, "short");
    });
    add("turn-long-2000", cls, async (room) => {
      await run(cls, room, "noop");
      return run(cls, room, "long", 2000);
    });
    add("turn-server-tool", cls, async (room) => {
      await run(cls, room, "noop");
      return run(cls, room, "tool");
    });
    add("turn-approval-pending", cls, async (room) => {
      await run(cls, room, "noop");
      return run(cls, room, "approve");
    });
    add("queued-3", cls, async (room) => {
      await run(cls, room, "noop");
      return run(cls, room, "queued");
    });
    if (cls === "think")
      add("submission", cls, async (room) => {
        await run(cls, room, "noop");
        return run(cls, room, "submit");
      });
    if (cls === "think")
      add("submission-workflow", cls, async (room) => {
        await run(cls, room, "noop");
        return run(cls, room, "submitWorkflow");
      });
    add("recovery-transient", cls, async (room) => {
      await run(cls, room, "noop");
      return run(cls, room, "transient");
    });
    add("recovery-transient-throw", cls, async (room) => {
      await run(cls, room, "noop");
      return run(cls, room, "transient", "throw");
    });
    add("recovery-abort", cls, async (room) => {
      await run(cls, room, "noop");
      await run(cls, room, "abortMidStream");
      // new instance: counts from construction through recovery
      return run(cls, room, "awaitIdle", undefined, false);
    });
    add("connect-500", cls, async (room) => {
      await run(cls, room, "seed", 500);
      await run(cls, room, "noop");
      const ws = await connect(cls, room, 1000);
      const r = await run(cls, room, "noop", undefined, false);
      return { ...r, ws };
    });
    add("turn-slow-300", cls, async (room) => {
      await run(cls, room, "noop");
      return run(cls, room, "long", "300 delay 5");
    });
    add("resume-mid-stream", cls, async (room) => {
      await run(cls, room, "noop");
      const turn = run(cls, room, "long", "300 delay 5");
      await streaming(cls, room);
      const ws = await connect(cls, room, 300);
      return { ...(await turn), ws };
    });
    add("idle-after-turn", cls, async (room) => {
      await run(cls, room, "short");
      await sleep(1000);
      await run(cls, room, "noop");
      await sleep(5000);
      return run(cls, room, "noop", undefined, false);
    });
  }
  add("startup-empty", "agent", async (room) => since("agent", room));
  add("fiber-3-stash", "agent", async (room) => {
    await run("agent", room, "noop");
    return run("agent", room, "fiber");
  });
  add("task-5-steps", "agent", async (room) => {
    await run("agent", room, "noop");
    return run("agent", room, "task");
  });
  add("schedule-fire", "agent", async (room) => {
    await run("agent", room, "noop");
    return run("agent", room, "schedule");
  });

  // Inside a facet: the root (PerfParent) runs each class as a subAgent. Two rows per
  // scenario: the facet's own counts, and what the root did meanwhile (@root).
  const facetRuns = [
    ["think", "short"],
    ["think", "long", "2000"],
    ["think", "queued"],
    ["think", "submit"],
    ["think", "submitWorkflow"],
    ["think", "tool"],
    ["chat", "short"],
    ["chat", "long", "2000"],
    ["chat", "queued"],
    ["chat", "tool"],
    ["agent", "fiber"],
    ["agent", "task"],
    ["agent", "schedule"],
    // three levels: root -> PerfParent facet -> class facet (rows @root, @mid)
    ["parent", "think", "short"],
    ["parent", "think", "queued"],
    ["parent", "chat", "queued"],
    ["parent", "agent", "task"],
    ["parent", "agent", "schedule"]
  ];
  for (const [fc, sc, a] of facetRuns as [string, string, string?][])
    add(`${fc}-${sc}${a ? `-${a}` : ""}`, "facet", async (room) => {
      await run("parent", room, "noop");
      return run(
        "parent",
        room,
        "facet",
        [fc, sc, a].filter(Boolean).join(":")
      );
    });

  const results: Record<string, Result> = {};
  for (const s of scenarios) {
    const key = `${s.cls}/${s.name}`;
    if (only && !only(key)) continue;
    const room = `${tag}-${s.cls}-${s.name}`;
    const t0 = Date.now();
    let r: Result;
    try {
      r = await s.fn(room);
    } catch (e) {
      r = { ok: false, error: String(e) };
    }
    const driverMs = Date.now() - t0;
    // Flatten nested facets: the leaf under the key, the levels above as @root, @mid.
    const levels: Result[] = [];
    let cur: Result = r;
    while (cur.facet) {
      const { facet, ...self } = cur;
      levels.push(self);
      cur = facet;
    }
    results[key] = { ...cur, ok: cur.ok ?? true, driverMs };
    levels.forEach((l, i) => {
      results[
        `${key}@${i === 0 ? "root" : i === levels.length - 1 ? "mid" : `mid${i}`}`
      ] = l;
    });
  }
  return results;
}
