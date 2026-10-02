import "./styles.css";
import {
  Button,
  InputArea,
  PoweredByCloudflare,
  Surface,
  Text
} from "@cloudflare/kumo";
import type { ToolPart, TranscriptMessage } from "agents/experimental/channels";
import {
  WebChannelClient,
  type WebChannelClientState
} from "agents/experimental/channels/web/client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

/** The agents this Worker serves, by the route segment that reaches them. */
const harnesses: Record<string, string> = {
  "ai-sdk": "AI SDK",
  pi: "pi"
};

// The URL hash picks the agent and room: #<harness>/<room>.
const [hashHarness = "", hashRoom = ""] = location.hash.slice(1).split("/");
const harness = Object.hasOwn(harnesses, hashHarness) ? hashHarness : "ai-sdk";
const room = hashRoom || "default";
const protocol = location.protocol === "https:" ? "wss:" : "ws:";
// Each browser is its own participant, so it runs only its own tool calls.
const me = (localStorage.me ??= `browser-${crypto.randomUUID().slice(0, 6)}`);
const client = new WebChannelClient(
  `${protocol}//${location.host}/channels/${harness}/${room}?as=${me}`
);

function switchHarness(next: string) {
  location.hash = `${next}/${room}`;
  location.reload();
}

function useChannels(): WebChannelClientState {
  return useSyncExternalStore(
    (listener) => client.subscribe(listener),
    () => client.state
  );
}

function App() {
  const { connected, you, messages, turns } = useChannels();
  const [input, setInput] = useState("");
  const running = turns.find((turn) => turn.status === "running");
  const queued = turns.filter((turn) => turn.status === "queued").length;
  const answered = useRef(new Set<string>());

  // Run getLocation calls this participant owns.
  useEffect(() => {
    for (const message of messages) {
      for (const part of message.parts) {
        if (!isPendingLocation(part) || part.owner !== you?.id) continue;
        const turnId = turnOf(message)?.turnId;
        if (!turnId || answered.current.has(part.toolCallId)) continue;
        answered.current.add(part.toolCallId);
        const city = Intl.DateTimeFormat().resolvedOptions().timeZone;
        void client
          .send({
            type: "tool-result",
            eventId: `result:${part.toolCallId}`,
            turnId,
            toolCallId: part.toolCallId,
            result: { ok: true, output: { timeZone: city } }
          })
          .catch(() => {});
      }
    }
  });

  function turnOf(message: TranscriptMessage) {
    return turns.find(
      (turn) =>
        turn.status === "settled" && turn.messageIds.includes(message.id)
    );
  }

  function send() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    const id = crypto.randomUUID();
    void client.send({
      type: "message",
      eventId: id,
      message: { id, role: "user", parts: [{ type: "text", text }] }
    });
  }

  function approve(
    message: TranscriptMessage,
    part: ToolPart,
    approved: boolean
  ) {
    const turnId = turnOf(message)?.turnId;
    if (!turnId || !part.approval) return;
    void client.send({
      type: "approval-response",
      turnId,
      approvalId: part.approval.id,
      approved
    });
  }

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between gap-4">
        <Text variant="heading2" as="h1">
          Channels
        </Text>
        <label className="flex items-center gap-2 text-sm">
          Harness
          <select
            value={harness}
            onChange={(event) => switchHarness(event.target.value)}
            className="rounded border border-kumo-line bg-kumo-base px-2 py-1"
          >
            {Object.entries(harnesses).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Text size="sm">
        {connected ? `Connected as ${you?.id}` : "Connecting…"}
        {queued > 0 && ` · ${queued} queued`}
      </Text>
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto">
        {messages.map((message) => (
          <Surface key={message.id} className="rounded-lg p-3">
            <Text size="xs" bold>
              {message.role}
            </Text>
            {message.parts.map((part, index) => (
              <div key={index} className="whitespace-pre-wrap text-sm">
                {part.type === "text" && part.text}
                {part.type === "reasoning" && (
                  <span className="opacity-60">{part.text}</span>
                )}
                {part.type === "tool" && (
                  <span className="font-mono">
                    {part.toolName}: {part.state}
                    {part.owner !== undefined &&
                      part.owner !== you?.id &&
                      " (not yours to run)"}
                    {part.state === "approval-requested" && (
                      <span className="ml-2 inline-flex gap-2">
                        <Button onClick={() => approve(message, part, true)}>
                          Approve
                        </Button>
                        <Button
                          variant="secondary"
                          onClick={() => approve(message, part, false)}
                        >
                          Reject
                        </Button>
                      </span>
                    )}
                  </span>
                )}
              </div>
            ))}
          </Surface>
        ))}
      </div>
      <div className="flex gap-2">
        <InputArea
          value={input}
          onValueChange={setInput}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          placeholder="What's the weather where I am?"
          rows={2}
          className="flex-1"
        />
        {running ? (
          <Button
            variant="secondary"
            onClick={() =>
              void client.send({ type: "cancel", turnId: running.turnId })
            }
          >
            Stop
          </Button>
        ) : (
          <Button onClick={send}>Send</Button>
        )}
      </div>
      <PoweredByCloudflare />
    </div>
  );
}

function isPendingLocation(
  part: TranscriptMessage["parts"][number]
): part is ToolPart {
  return (
    part.type === "tool" &&
    part.toolName === "getLocation" &&
    part.state === "input-available"
  );
}

createRoot(document.getElementById("root")!).render(<App />);
