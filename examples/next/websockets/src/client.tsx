import {
  Badge,
  Button,
  Empty,
  Input,
  PoweredByCloudflare,
  Surface,
  Text
} from "@cloudflare/kumo";
import {
  BroadcastIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  PlugsConnectedIcon,
  SunIcon
} from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { useAgent, type AgentTransport } from "agents/react";
import { newWebSocketRpcSession } from "capnweb";
import type { Member, RoomMessage, ServerFrame } from "./index";
import "./styles.css";

/** The room's RpcTarget, as seen from the browser. */
type RoomApi = {
  say(nick: string, text: string): Promise<RoomMessage>;
  history(): Promise<RoomMessage[]>;
  members(): Promise<Member[]>;
};

const params = new URLSearchParams(location.search);
const room = params.get("room") ?? "lobby";
const nick =
  params.get("nick") ??
  localStorage.getItem("next-websockets-nick") ??
  `web-${Math.random().toString(36).slice(2, 6)}`;
localStorage.setItem("next-websockets-nick", nick);

function ModeToggle() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") ?? "light"
  );
  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);
  return (
    <Button
      variant="ghost"
      shape="square"
      aria-label="Toggle theme"
      onClick={() => setMode((value) => (value === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

/**
 * One member of the room, connected with `useAgent` over the chosen
 * transport. The plain Durable Object needs nothing from `Agent`: the
 * WebSockets capability identifies it (so `identified` flips), answers
 * `stub` calls against `RoomCallables`, and hands every other frame — the
 * room's own join/message/leave — to `onMessage`.
 */
function RoomPane({ transport }: { transport: AgentTransport }) {
  const [log, setLog] = useState<string[]>([]);
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [draft, setDraft] = useState("");
  const append = useCallback(
    (line: string) => setLog((prev) => [...prev.slice(-30), line]),
    []
  );

  const agent = useAgent({
    agent: "room-object",
    name: room,
    query: { nick: `${nick}@${transport}` },
    transport,
    onMessage: (event) => {
      // Non-protocol frames: the room's own. Identity and rpc frames are
      // consumed by the hook before this runs.
      const frame = JSON.parse(String(event.data)) as ServerFrame;
      switch (frame.type) {
        case "history":
          setMessages(frame.messages);
          break;
        case "message":
          setMessages((prev) => [...prev.slice(-49), frame.message]);
          break;
        case "join":
        case "leave":
          append(`${frame.type}: ${frame.nick} (${frame.members} online)`);
          break;
        default:
          append(JSON.stringify(frame));
      }
    },
    onClose: (event) => append(`closed ${event.code} ${event.reason}`)
  });
  const stub = agent.stub as RoomApi;

  // The same interface on every wire: `stub.members()` is an rpc frame on
  // "cf-websocket" and the identical frame through the pipe on "capnweb".
  const refreshMembers = useCallback(async () => {
    setMembers(await stub.members());
  }, [stub]);
  useEffect(() => {
    if (!agent.identified) return;
    append(`identified as ${agent.agent}/${agent.name} over ${transport}`);
    void refreshMembers();
  }, [
    agent.identified,
    agent.agent,
    agent.name,
    append,
    refreshMembers,
    transport
  ]);

  const send = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const text = draft.trim();
      if (!text) return;
      setDraft("");
      // A callable call; the broadcast comes back as a "message" frame.
      await stub.say(`${nick}@${transport}`, text);
    },
    [draft, stub, transport]
  );

  const countdown = useCallback(async () => {
    // A streaming callable: the ReadableStream result arrives as chunks.
    await agent.call("countdown", [3], {
      stream: {
        onChunk: (n) => append(`countdown chunk ${String(n)}`),
        onDone: () => append("countdown done")
      }
    });
  }, [agent, append]);

  return (
    <Surface className="flex min-h-0 flex-1 flex-col rounded-lg border border-kumo-line">
      <div className="flex items-center justify-between gap-2 border-b border-kumo-line px-3 py-2">
        <div className="flex items-center gap-2">
          <PlugsConnectedIcon size={16} />
          <Text bold>{transport}</Text>
          <Badge variant={agent.identified ? "primary" : "secondary"}>
            {agent.identified ? "identified" : "connecting"}
          </Badge>
        </div>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void refreshMembers()}
          >
            stub.members()
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void countdown()}
          >
            call("countdown")
          </Button>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-0">
        <div className="min-h-0 space-y-1 overflow-y-auto border-r border-kumo-line p-3">
          {messages.length === 0 ? (
            <Empty title="No messages" description="Say something below." />
          ) : (
            messages.map((m) => (
              <div key={m.id}>
                <Text size="sm" bold>
                  {m.nick}
                </Text>{" "}
                <Text size="sm">{m.text}</Text>
              </div>
            ))
          )}
        </div>
        <div className="min-h-0 overflow-y-auto p-3">
          <Text size="xs" variant="secondary">
            members: {members.map((m) => m.nick).join(", ") || "—"}
          </Text>
          <pre className="mt-2 whitespace-pre-wrap text-xs">
            {log.join("\n")}
          </pre>
        </div>
      </div>
      <form
        onSubmit={send}
        className="flex gap-2 border-t border-kumo-line p-2"
      >
        <Input
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          placeholder={`stub.say("${nick}@${transport}", …)`}
          className="flex-1"
        />
        <Button
          type="submit"
          variant="primary"
          disabled={!agent.identified || draft.trim() === ""}
          icon={<PaperPlaneRightIcon size={16} />}
        >
          Send
        </Button>
      </form>
    </Surface>
  );
}

/**
 * A non-React client: the same RoomCallables served natively as a Cap'n Web
 * session at `?__agents_rpc=capnweb`. This is what a CLI or another Worker
 * would use; there is no Agent protocol on this wire, just the methods.
 */
function RawCallablesPane() {
  const [result, setResult] = useState("");
  const run = useCallback(async () => {
    const url = new URL(`/agents/room-object/${room}`, location.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("__agents_rpc", "capnweb");
    const rpc = newWebSocketRpcSession<RoomApi>(url.toString());
    try {
      await rpc.say(
        `${nick}@raw-capnweb`,
        "hello from a raw Cap'n Web session"
      );
      const history = await rpc.history();
      setResult(JSON.stringify(history.slice(-3), null, 2));
    } finally {
      rpc[Symbol.dispose]();
    }
  }, []);
  return (
    <Surface className="rounded-lg border border-kumo-line p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BroadcastIcon size={16} />
          <Text bold>raw Cap'n Web callables</Text>
          <Badge variant="secondary">?__agents_rpc=capnweb</Badge>
        </div>
        <Button size="sm" variant="secondary" onClick={() => void run()}>
          say() then history()
        </Button>
      </div>
      {result && (
        <pre className="mt-2 whitespace-pre-wrap text-xs">{result}</pre>
      )}
    </Surface>
  );
}

function App() {
  return (
    <div className="flex h-screen flex-col gap-3 p-3">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Text bold>WebSockets</Text>
          <Badge variant="secondary">room {room}</Badge>
          <Badge variant="secondary">nick {nick}</Badge>
          <Text size="xs" variant="secondary">
            one plain Durable Object, two transports, one interface
          </Text>
        </div>
        <ModeToggle />
      </header>
      <div className="flex min-h-0 flex-1 gap-3">
        <RoomPane transport="cf-websocket" />
        <RoomPane transport="capnweb" />
      </div>
      <RawCallablesPane />
      <div className="flex justify-end">
        <PoweredByCloudflare />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
