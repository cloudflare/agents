import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/think/react";
import { getToolName, isToolUIPart } from "ai";
import {
  ChatCircleTextIcon,
  InfoIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  SparkleIcon,
  SunIcon,
  TrashIcon,
  WrenchIcon
} from "@phosphor-icons/react";
import {
  Badge,
  Button,
  PoweredByCloudflare,
  Surface,
  Text
} from "@cloudflare/kumo";
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import "./styles.css";

type ConnectionStatus = "connecting" | "connected" | "disconnected";

type SkillSummary = {
  name: string;
  description: string;
};

// Human-readable label for a skill tool call (activate_skill,
// run_skill_script, read_skill_resource) shown inline in the transcript.
function toolActivityLabel(toolName: string, input: unknown): string {
  const args = (input ?? {}) as { name?: string; path?: string };
  if (toolName === "activate_skill") return `Activated skill: ${args.name}`;
  if (toolName === "run_skill_script") {
    return `Ran script: ${args.name}/${args.path}`;
  }
  if (toolName === "read_skill_resource") {
    return `Read resource: ${args.path ?? args.name}`;
  }
  return toolName;
}

function truncate(value: string, max = 600): string {
  return value.length > max ? `${value.slice(0, max)}\n…` : value;
}

function ToolActivity({ part }: { part: unknown }) {
  const toolName = getToolName(part as Parameters<typeof getToolName>[0]);
  const { input, output, state } = part as {
    input?: unknown;
    output?: unknown;
    state?: string;
  };
  const done = state === "output-available";

  return (
    <div className="rounded-lg border border-kumo-line bg-kumo-surface p-2.5">
      <div className="flex items-center gap-2">
        <WrenchIcon size={14} className="text-kumo-accent" />
        <Text size="xs" bold>
          {toolActivityLabel(toolName, input)}
        </Text>
        <Badge variant="secondary">{done ? "done" : "running"}</Badge>
      </div>
      {done && output != null && toolName !== "activate_skill" && (
        <pre className="mt-1.5 whitespace-pre-wrap font-sans text-xs text-kumo-subtle">
          {truncate(
            typeof output === "string"
              ? output
              : JSON.stringify(output, null, 2)
          )}
        </pre>
      )}
    </div>
  );
}

function ModeToggle() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") || "light"
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
      onClick={() =>
        setMode((current) => (current === "light" ? "dark" : "light"))
      }
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const dot =
    status === "connected"
      ? "bg-green-500"
      : status === "connecting"
        ? "bg-yellow-500"
        : "bg-red-500";
  const label =
    status === "connected"
      ? "Connected"
      : status === "connecting"
        ? "Connecting..."
        : "Disconnected";

  return (
    <output className="flex items-center gap-2">
      <span className={`size-2 rounded-full ${dot}`} />
      <span className="text-xs text-kumo-subtle">{label}</span>
    </output>
  );
}

function App() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState(
    "Write release notes for these changes: added bundled Think skills, added the agents:skills import, added a skill activation tool. Use the release notes script."
  );
  const [skills, setSkills] = useState<SkillSummary[]>([]);

  const agent = useAgent({
    agent: "SkillsAgent",
    name: "demo",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback((event: Event) => {
      console.error("Agent connection error", event);
      setConnectionStatus("disconnected");
    }, [])
  });

  const { messages, sendMessage, clearHistory, status } = useAgentChat({
    agent,
    experimental_throttle: 100
  });

  // Skills the model has activated this conversation, derived from
  // `activate_skill` tool calls. Used to light up the sidebar.
  const activatedSkills = useMemo(() => {
    const active = new Set<string>();
    for (const message of messages) {
      for (const part of message.parts ?? []) {
        if (
          isToolUIPart(part) &&
          getToolName(part) === "activate_skill" &&
          part.input != null
        ) {
          const name = (part.input as { name?: string }).name;
          if (name) active.add(name);
        }
      }
    }
    return active;
  }, [messages]);

  useEffect(() => {
    agent
      .call("listSkills", [])
      .then((result) => setSkills(result as SkillSummary[]))
      .catch((error) => console.error("Failed to load skills", error));
  }, [agent]);

  const isStreaming = status === "streaming" || status === "submitted";

  function send() {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }

  return (
    <main className="min-h-screen bg-kumo-base text-kumo-default">
      <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-6 py-8">
        <header className="flex items-center justify-between gap-4">
          <div>
            <Text size="lg" bold>
              Agent Skills
            </Text>
            <span className="mt-1 block">
              <Text size="sm" variant="secondary">
                Import a local skills directory with `agents:skills` and let
                Think expose the right skill tools.
              </Text>
            </span>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={connectionStatus} />
            <ModeToggle />
          </div>
        </header>

        <Surface className="rounded-xl p-4 ring ring-kumo-line">
          <div className="flex gap-3">
            <InfoIcon
              size={20}
              weight="bold"
              className="mt-0.5 shrink-0 text-kumo-accent"
            />
            <div>
              <Text size="sm" bold>
                What this demo shows
              </Text>
              <span className="mt-1 block">
                <Text size="xs" variant="secondary">
                  The Worker imports its `./skills` directory with
                  `agents:skills`. The Agents Vite plugin bundles each
                  `SKILL.md`, Think registers them through `getSkills()`, and
                  the model can call `activate_skill` when a task matches a
                  skill — activated skills light up on the right. The
                  release-notes skill also demonstrates `run_skill_script` with
                  a TypeScript script.
                </Text>
              </span>
            </div>
          </div>
        </Surface>

        <section className="grid gap-4 lg:grid-cols-[1fr_22rem]">
          <Surface className="flex min-h-128 flex-col rounded-xl ring ring-kumo-line">
            <div className="border-b border-kumo-line p-4">
              <Text size="sm" bold>
                Chat
              </Text>
            </div>

            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              {messages.length === 0 ? (
                <div className="flex h-full items-center justify-center text-center">
                  <div>
                    <ChatCircleTextIcon
                      size={32}
                      className="mx-auto text-kumo-subtle"
                    />
                    <span className="mt-2 block">
                      <Text size="sm" variant="secondary">
                        Try the prefilled release notes prompt, or ask for a
                        debugging plan.
                      </Text>
                    </span>
                  </div>
                </div>
              ) : (
                messages.map((message) => (
                  <div
                    key={message.id}
                    className={`rounded-xl border border-kumo-line p-3 ${
                      message.role === "user"
                        ? "bg-kumo-surface"
                        : "bg-kumo-elevated"
                    }`}
                  >
                    <div className="mb-2 flex items-center gap-2">
                      <Badge>{message.role}</Badge>
                    </div>
                    <div className="space-y-2">
                      {(message.parts ?? []).map((part, index) => {
                        if (part.type === "text") {
                          return part.text ? (
                            <pre
                              key={index}
                              className="whitespace-pre-wrap font-sans text-sm text-kumo-default"
                            >
                              {part.text}
                            </pre>
                          ) : null;
                        }
                        if (isToolUIPart(part)) {
                          return (
                            <ToolActivity
                              key={part.toolCallId ?? index}
                              part={part}
                            />
                          );
                        }
                        return null;
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="border-t border-kumo-line p-4">
              <textarea
                aria-label="Message"
                className="min-h-24 w-full rounded-lg border border-kumo-line bg-kumo-surface p-3 text-sm outline-none"
                value={input}
                onChange={(event) => setInput(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    (event.metaKey || event.ctrlKey)
                  ) {
                    send();
                  }
                }}
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  disabled={isStreaming || input.trim().length === 0}
                  onClick={send}
                  icon={<PaperPlaneRightIcon size={16} />}
                >
                  Send
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => clearHistory()}
                  icon={<TrashIcon size={16} />}
                >
                  Clear
                </Button>
              </div>
            </div>
          </Surface>

          <aside className="space-y-4">
            <Surface className="rounded-xl p-4 ring ring-kumo-line">
              <div className="mb-3 flex items-center gap-2">
                <SparkleIcon size={18} className="text-kumo-accent" />
                <Text size="sm" bold>
                  Bundled skills
                </Text>
              </div>
              <div className="space-y-3">
                {skills.map((skill) => {
                  const active = activatedSkills.has(skill.name);
                  return (
                    <div
                      key={skill.name}
                      className={`rounded-lg border p-3 ${
                        active
                          ? "border-kumo-accent bg-kumo-surface"
                          : "border-kumo-line"
                      }`}
                    >
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <Text size="sm" bold>
                          {skill.name}
                        </Text>
                        {active ? (
                          <Badge>active</Badge>
                        ) : (
                          <Badge variant="secondary">on demand</Badge>
                        )}
                      </div>
                      <Text size="xs" variant="secondary">
                        {skill.description}
                      </Text>
                    </div>
                  );
                })}
              </div>
            </Surface>

            <Surface className="rounded-xl p-4 ring ring-kumo-line">
              <Text size="sm" bold>
                Prompts to try
              </Text>
              <div className="mt-3 space-y-2">
                {[
                  "Write release notes for these changes: added Think skills, the agents:skills import, and skill tools. Use the release notes script.",
                  "Make a debug plan for an intermittent WebSocket disconnect.",
                  "Draft a test plan for a new password reset flow.",
                  "What skills are available in this demo?"
                ].map((prompt) => (
                  <Button
                    key={prompt}
                    variant="secondary"
                    className="w-full justify-start text-left"
                    onClick={() => setInput(prompt)}
                  >
                    {prompt}
                  </Button>
                ))}
              </div>
            </Surface>
          </aside>
        </section>

        <footer className="flex justify-center">
          <PoweredByCloudflare />
        </footer>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
