# Hosting DX — what the author actually writes

A prototype to *feel* the ergonomics of each packaging for wiring a
transport-free agent onto a Cloudflare Durable Object (ISSUE-030). Same agent
in every case — only the wiring differs. **Option A exists today; B/C/D are
sketches of proposed helpers.** Sketches assume the ISSUE-030 rename
`AgentHost → AgentRuntime`.

---

## The agent — identical in every option

The transport-free agent never changes. It's a plain `Think` subclass,
constructed over a narrow capability object, testable in plain Node. This is
the part authors spend their time on; the wiring below is the ~once-per-file
boilerplate we're comparing.

```ts
import { Think, action } from "@cloudflare/think";
import { z } from "zod";

class SupportAgent extends Think<Env> {
  getModel() { return "@cf/meta/llama-3.3-70b-instruct"; }
  getSystemPrompt() { return "You are a concise support agent."; }

  getActions() {
    return {
      refund: action({
        description: "Issue a refund for an order",
        inputSchema: z.object({ orderId: z.string(), cents: z.number().int() }),
        approval: true,                        // human-in-the-loop
        execute: async ({ orderId, cents }) => issueRefund(orderId, cents),
      }),
    };
  }
}
```

And the Worker entrypoint is the **same in every option** (unchanged from the
original Think):

```ts
export default {
  fetch: (req: Request, env: Env) =>
    routeAgentRequest(req, env) ?? new Response("Not found", { status: 404 }),
} satisfies ExportedHandler<Env>;
```

So the *only* thing that varies is how you turn `SupportAgent` into the DO.

---

## Option A — factory / mixin  *(what exists today)*

```ts
export const SupportAgentDO = hostAgent(SupportAgent);
```

- **One line.** Terse.
- **The magic is total and opaque:** a function returns a class; you can't see
  that the DO *has-a* agent, or where `fetch`/`alarm` go. To learn what
  `SupportAgentDO` even is, you read the factory.
- Typed `<A extends Think>` — a non-chat `extends Agent` agent can't use it.

## Option B — intermediate base class

```ts
export class SupportAgentDO extends ChatAgentDurableObject<SupportAgent> {
  createAgent(rt: AgentRuntime) {
    return new SupportAgent(rt);
  }
}
```

- **Ordinary inheritance** — reads like every other DO an author has written.
- **One visible seam** (`createAgent`) that names the has-a relationship: this
  DO *makes* a `SupportAgent`. The lifecycle is inherited, out of the way.
- Layering is the type you extend: `AgentDurableObject` (no chat) vs
  `ChatAgentDurableObject`.
- Cost: ~3 lines instead of 1, and the lifecycle is still "somewhere in the
  base" — but it's a *normal base class you can open*, not a synthesized one.

## Option C — plain composition + a lifecycle driver

```ts
export class SupportAgentDO extends DurableObject {
  #rt = createAgentRuntime(this.ctx, this.env, (rt) => new SupportAgent(rt), { chat: true });

  fetch = this.#rt.fetch;
  alarm = this.#rt.alarm;
  webSocketMessage = this.#rt.webSocketMessage;
  webSocketClose = this.#rt.webSocketClose;
}
```

- **The has-a relationship is right there on the page:** the DO owns a runtime
  that owns the agent. Nothing is hidden by inheritance or a factory.
- The forwarding lines are explicit — which is either honest (you see exactly
  what the DO delegates) or noise (four lines of plumbing), depending on taste.
- `createAgentRuntime` owns only the *subtle* part (next section); the
  composition stays legible.
- Drop `{ chat: true }` and don't forward the WS methods → a non-chat agent.
  Same helper, no separate type.

## Option D — fully manual  *(no helper — to show what the others save)*

```ts
export class SupportAgentDO extends DurableObject {
  #agent?: SupportAgent;
  #ready?: Promise<SupportAgent>;
  #transport?: ChatTransport;

  #ensure(nameHint?: string) {
    return (this.#ready ??= this.ctx.blockConcurrencyWhile(async () => {
      const store = createDurableKeyValueStore(this.ctx.storage);
      const name = store.get("cf:name") ?? nameHint ?? this.ctx.id.toString();
      if (nameHint && !store.get("cf:name")) store.put("cf:name", nameHint);

      const rt: AgentRuntime = {
        className: "SupportAgent",
        name,
        store,
        alarm: createDurableAlarmTimer({ storage: this.ctx.storage, initial: await this.ctx.storage.getAlarm() }),
        clock: { now: () => Date.now() },
        ids: { newId: (p) => `${p}_${crypto.randomUUID()}` },
        // …spawner, onDestroyed, …
      };
      const agent = new SupportAgent(rt);
      this.#transport = attachChatTransport(agent, createDurableConnectionRegistry(this.ctx));
      await agent.start();                          // exactly once per activation
      return (this.#agent = agent);
    }));
  }

  async fetch(req: Request) {
    const agent = await this.#ensure(req.headers.get("x-agent-name") ?? undefined);
    if ((req.headers.get("Upgrade") ?? "").toLowerCase() === "websocket") {
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, [crypto.randomUUID()]);
      await this.#transport!.onConnect(wrapSocket(server));
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response(null, { status: 404 });
  }

  async alarm() { const a = await this.#ensure(); this.#timer.onPlatformAlarm(); await a.onAlarm(); }
  async webSocketMessage(ws: WebSocket, msg: string) { await this.#ensure(); await this.#transport!.onMessage(wrapSocket(ws), msg); }
  async webSocketClose(ws: WebSocket) { await this.#ensure(); this.#transport!.onClose(wrapSocket(ws)); }
  // …plus __call / __init / __destroy RPC methods for delegation + routing…
}
```

- This is *everything* A/B/C hide. It's ~40 lines of fiddly, identical-across-
  every-agent code, and it's exactly where the subtle bugs live (double-start,
  a lost alarm, a socket not re-attached after hibernation).
- Nobody should write this per agent. It's here only to show what the helper
  earns — and to prove there's no deep magic: A/B/C are all *this*, packaged.

---

## Why the helper isn't just "forward four methods"

The reason a reusable driver/base earns its place — the substance behind the
one `#ensure` above:

- **start-once, and lazy.** `agent.start()` must run exactly once per
  activation inside `blockConcurrencyWhile`, and *lazily* — the instance name
  can arrive on the first request's `x-agent-name` header, not at construction,
  so you can't just `new SupportAgent()` in a field.
- **the alarm mirror.** DO alarms are async (`setAlarm`/`getAlarm`) but the
  agent's `AlarmTimer` port is sync; the driver keeps the mirror and flushes.
- **hibernation.** A woken DO has live sockets but no in-memory transport; the
  driver re-attaches it.

A naive `#agent = new SupportAgent(rt)` field is *not enough* for any of these.
That's the irreducible platform-lifecycle work — and the only real question is
how it's packaged.

---

## The lean case — a non-chat agent (`extends Agent`)

Where the options diverge most. A reminder agent that only schedules and
exposes RPC — no chat, no WebSockets:

```ts
class ReminderAgent extends Agent {           // the lighter base, no chat
  @callable() async setReminder(at: string, text: string) { /* this.schedule(...) */ }
  fireReminder(payload: { text: string }) { /* … */ }
}
```

| Option | Lean wiring | Note |
|---|---|---|
| **A** factory | `hostAgent(ReminderAgent)` | **Fails today** — typed `<A extends Think>`. Needs the layered factory. |
| **B** base class | `class ReminderDO extends AgentDurableObject<ReminderAgent> { createAgent(rt){ return new ReminderAgent(rt); } }` | Extend the *minimal* base — no chat plumbing. Clean. |
| **C** driver | `#rt = createAgentRuntime(this.ctx, this.env, rt => new ReminderAgent(rt)); alarm = this.#rt.alarm;` | Omit `{ chat: true }`, forward only `alarm`. Clean. |

---

## Side by side

| | A: factory | B: base class | C: composition + driver | D: manual |
|---|---|---|---|---|
| Author lines | 1 | ~3 | ~6 | ~40 |
| Reads as… | a spell | ordinary inheritance | explicit has-a | raw platform code |
| Where's the magic | all of it, in a fn | in the base you can open | only the lifecycle helper | none |
| Non-chat agent | ✗ (today) | ✓ (`AgentDurableObject`) | ✓ (omit `chat`) | ✓ |
| Layering shows as | — | the type you extend | a config flag | hand-wired |
| Codegen can emit it | ✓ | ✓ | ✓ | n/a |

## A read, not a verdict

- **C** is the most *honest* — the DO-has-a-agent model is on the page, and it's
  the one to document as the mental model even if most people use a shortcut.
- **B** is the most *familiar* — plain inheritance, one named seam; likely the
  best default for the majority who don't want to see forwarding.
- **A** stays as one-line sugar for the terse-loving, ideally generated by the
  framework/Vite tier (ISSUE-013) so nobody hand-writes a wrapper at all.
- **D** is never the answer, but it's why B/C/A exist.

They're not exclusive: implement the driver (C's `createAgentRuntime`) as the
core, build B's base class on top of it, and A's factory on top of B. One
lifecycle implementation, three author-facing skins — pick per taste, and the
default in docs is C's model with B as the everyday shortcut.
