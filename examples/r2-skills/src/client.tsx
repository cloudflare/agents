import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/think/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import {
  Badge,
  Button,
  Empty,
  PoweredByCloudflare,
  Surface,
  Text
} from "@cloudflare/kumo";
import {
  ChatCircleTextIcon,
  InfoIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  PlusIcon,
  SparkleIcon,
  SunIcon,
  TrashIcon,
  WrenchIcon,
  XIcon
} from "@phosphor-icons/react";
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AddSkillResult, SkillSummary } from "./server";
import "./styles.css";

const DEMO = {
  title: "R2 Skills",
  subtitle: "Agent Skills loaded from an R2 bucket, under skills/.",
  explainer:
    "Each skills/<name>/SKILL.md object is a skill. The agent uploads two on first start; add or delete one here and it changes on the next message. The release-notes script runs in a Dynamic Worker through run_skill_script.",
  prompts: [
    "Write release notes for: added R2 skills, fixed a reconnect bug, updated the docs.",
    "Explain Durable Objects like a pirate.",
    "What skills do you have?"
  ]
};

type ConnectionStatus = "connecting" | "connected" | "disconnected";

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

function formatValue(value: unknown): string {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > 1200 ? `${text.slice(0, 1200)}\n…` : text;
}

type ToolPart = Extract<UIMessage["parts"][number], { toolCallId: string }>;

function ToolCall({ part }: { part: ToolPart }) {
  const name = getToolName(part);
  const running =
    part.state === "input-streaming" || part.state === "input-available";

  return (
    <div className="rounded-lg border border-kumo-line bg-kumo-base p-2.5">
      <div className="flex items-center gap-2">
        <WrenchIcon size={14} className="text-kumo-accent" />
        <Text size="xs" bold>
          {name}
        </Text>
        <Badge variant="secondary">
          {running ? "running" : part.state.replace("output-", "")}
        </Badge>
      </div>
      {part.input != null && (
        <pre className="mt-1.5 whitespace-pre-wrap font-mono text-xs text-kumo-subtle">
          {formatValue(part.input)}
        </pre>
      )}
      {part.state === "output-available" && (
        <pre className="mt-1.5 whitespace-pre-wrap border-t border-kumo-line pt-1.5 font-mono text-xs text-kumo-default">
          {formatValue(part.output)}
        </pre>
      )}
      {part.state === "output-error" && (
        <pre className="mt-1.5 whitespace-pre-wrap rounded bg-red-500/10 p-2 font-mono text-xs text-kumo-danger">
          {part.errorText}
        </pre>
      )}
    </div>
  );
}

function Message({
  message,
  streaming
}: {
  message: UIMessage;
  streaming: boolean;
}) {
  return (
    <div
      className={`rounded-xl border border-kumo-line p-3 ${
        message.role === "user" ? "bg-kumo-base" : "bg-kumo-elevated"
      }`}
    >
      <div className="mb-2">
        <Badge>{message.role}</Badge>
      </div>
      <div className="space-y-2">
        {message.parts.map((part, index) => {
          const last = index === message.parts.length - 1;
          if (part.type === "text") {
            if (part.text.length === 0 && part.state !== "streaming") {
              return null;
            }
            return message.role === "user" ? (
              <p key={index} className="whitespace-pre-wrap text-sm">
                {part.text}
              </p>
            ) : (
              <Streamdown
                key={index}
                className="sd-theme text-sm"
                plugins={{ code }}
                controls={false}
                isAnimating={streaming && last}
              >
                {part.text}
              </Streamdown>
            );
          }
          if (part.type === "reasoning") {
            if (part.text.length === 0 && part.state !== "streaming") {
              return null;
            }
            return (
              <div
                key={index}
                className="rounded-lg border border-dashed border-kumo-line p-2"
              >
                <Text size="xs" variant="secondary" bold>
                  Reasoning
                </Text>
                <p className="mt-1 whitespace-pre-wrap text-xs text-kumo-subtle">
                  {part.text}
                </p>
              </div>
            );
          }
          if (isToolUIPart(part)) {
            return <ToolCall key={part.toolCallId} part={part} />;
          }
          return null;
        })}
      </div>
    </div>
  );
}

function AddSkillForm({
  onAdd
}: {
  onAdd: (input: {
    name: string;
    description: string;
    instructions: string;
  }) => Promise<AddSkillResult>;
}) {
  const [name, setName] = useState("haiku");
  const [description, setDescription] = useState(
    "Answer in a haiku. Use when the user asks for a poem or a haiku."
  );
  const [instructions, setInstructions] = useState(
    "Reply with a single haiku: five, seven, then five syllables."
  );
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    const result = await onAdd({ name, description, instructions });
    if (!result.ok) setError(result.error);
  }

  const inputClass =
    "w-full rounded-lg border border-kumo-line bg-kumo-base p-2 text-sm outline-none";

  return (
    <div className="space-y-2">
      <input
        aria-label="Skill name"
        className={inputClass}
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
      />
      <input
        aria-label="Skill description"
        className={inputClass}
        value={description}
        onChange={(event) => setDescription(event.currentTarget.value)}
      />
      <textarea
        aria-label="Skill instructions"
        className={`${inputClass} min-h-16`}
        value={instructions}
        onChange={(event) => setInstructions(event.currentTarget.value)}
      />
      {error && (
        <p className="rounded bg-red-500/10 p-2 text-xs text-kumo-danger">
          {error}
        </p>
      )}
      <Button
        variant="secondary"
        icon={<PlusIcon size={16} />}
        onClick={submit}
      >
        Add skill
      </Button>
    </div>
  );
}

function App() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState(DEMO.prompts[0]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);

  const agent = useAgent({
    agent: "SkillsAgent",
    name: "demo",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(() => setConnectionStatus("disconnected"), [])
  });

  const { messages, sendMessage, clearHistory, status } = useAgentChat({
    agent
  });
  const streaming = status === "streaming" || status === "submitted";

  const refreshSkills = useCallback(() => {
    agent
      .call<SkillSummary[]>("listSkills", [])
      .then(setSkills)
      .catch((error) => console.error("Failed to list skills", error));
  }, [agent]);

  useEffect(() => {
    if (connectionStatus === "connected") refreshSkills();
  }, [connectionStatus, refreshSkills]);
  useEffect(() => {
    if (!streaming) refreshSkills();
  }, [streaming, refreshSkills]);

  const activated = useMemo(() => {
    const names = new Set<string>();
    for (const message of messages) {
      for (const part of message.parts) {
        if (isToolUIPart(part) && getToolName(part) === "activate_skill") {
          const name = (part.input as { name?: unknown } | undefined)?.name;
          if (typeof name === "string") names.add(name);
        }
      }
    }
    return names;
  }, [messages]);

  function send() {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }

  async function addSkill(skill: {
    name: string;
    description: string;
    instructions: string;
  }) {
    const result = await agent.call<AddSkillResult>("addSkill", [skill]);
    refreshSkills();
    return result;
  }

  async function removeSkill(name: string) {
    await agent.call("removeSkill", [name]);
    refreshSkills();
  }

  return (
    <main className="min-h-screen bg-kumo-base text-kumo-default">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-6 py-8">
        <header className="flex items-center justify-between gap-4">
          <div>
            <Text size="lg" bold>
              {DEMO.title}
            </Text>
            <span className="mt-1 block">
              <Text size="sm" variant="secondary">
                {DEMO.subtitle}
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
                  {DEMO.explainer}
                </Text>
              </span>
            </div>
          </div>
        </Surface>

        <section className="grid gap-4 lg:grid-cols-[1fr_22rem]">
          <Surface className="flex min-h-128 flex-col rounded-xl ring ring-kumo-line">
            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              {messages.length === 0 ? (
                <Empty
                  icon={<ChatCircleTextIcon size={32} />}
                  title="No messages yet"
                  description="Pick a prompt on the right, or ask for anything."
                />
              ) : (
                messages.map((message, index) => (
                  <Message
                    key={message.id}
                    message={message}
                    streaming={streaming && index === messages.length - 1}
                  />
                ))
              )}
            </div>

            <div className="border-t border-kumo-line p-4">
              <textarea
                aria-label="Message"
                className="min-h-20 w-full rounded-lg border border-kumo-line bg-kumo-base p-3 text-sm outline-none"
                value={input}
                onChange={(event) => setInput(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    send();
                  }
                }}
              />
              <div className="mt-3 flex gap-2">
                <Button
                  disabled={streaming || input.trim().length === 0}
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
                  Skills
                </Text>
              </div>
              <div className="space-y-3">
                {skills.length === 0 && (
                  <Text size="xs" variant="secondary">
                    No skills yet.
                  </Text>
                )}
                {skills.map((skill) => (
                  <div
                    key={skill.name}
                    className={`rounded-lg border p-3 ${
                      activated.has(skill.name)
                        ? "border-kumo-accent"
                        : "border-kumo-line"
                    }`}
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <Text size="sm" bold>
                        {skill.name}
                      </Text>
                      <div className="flex items-center gap-1">
                        {activated.has(skill.name) && <Badge>used</Badge>}
                        <Button
                          variant="ghost"
                          shape="square"
                          size="sm"
                          aria-label={`Delete ${skill.name}`}
                          icon={<XIcon size={14} />}
                          onClick={() => removeSkill(skill.name)}
                        />
                      </div>
                    </div>
                    <Text size="xs" variant="secondary">
                      {skill.description}
                    </Text>
                    {skill.files.length > 0 && (
                      <ul className="mt-2 space-y-0.5 font-mono text-xs text-kumo-subtle">
                        {skill.files.map((file) => (
                          <li key={file}>{file}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </Surface>

            <Surface className="rounded-xl p-4 ring ring-kumo-line">
              <div className="mb-3">
                <Text size="sm" bold>
                  Add a skill
                </Text>
              </div>
              <AddSkillForm onAdd={addSkill} />
            </Surface>

            <Surface className="rounded-xl p-4 ring ring-kumo-line">
              <div className="mb-3">
                <Text size="sm" bold>
                  Prompts to try
                </Text>
              </div>
              <div className="space-y-2">
                {DEMO.prompts.map((prompt) => (
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

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
