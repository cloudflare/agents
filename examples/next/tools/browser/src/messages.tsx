// Renders pi's transcript with the chat building blocks in chat-ui.tsx.
// pi stores a tool call and its result as separate messages, so this pairs
// them up by call id and shows each call as one line, its screenshot (if
// any) under it.
import type { ImageContent, JsonValue } from "@earendil-works/pi-ai";
import { WarningCircleIcon } from "@phosphor-icons/react";
import {
  AssistantMessage,
  Markdown,
  Reasoning,
  ToolCall,
  UserMessage
} from "./chat-ui";
import type { ToolCallState } from "./chat-ui";
import type { TranscriptMessage, TranscriptPart } from "./protocol";
import type { PiRunningTool } from "./view";

type ToolCallPart = Extract<TranscriptPart, { type: "tool-call" }>;
type ToolResultPart = Extract<TranscriptPart, { type: "tool-result" }>;

/** A user message, or everything the agent did in reply to one. */
export type Turn =
  | { readonly kind: "user"; readonly message: TranscriptMessage }
  | { readonly kind: "notice"; readonly message: TranscriptMessage }
  | {
      readonly kind: "agent";
      readonly id: string;
      readonly messages: readonly TranscriptMessage[];
    };

/**
 * Groups consecutive assistant and tool messages into one agent turn, so a
 * run of model calls and tool results reads as one reply.
 */
export function groupTurns(messages: readonly TranscriptMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages) {
    if (message.role === "user" || message.role === "notice") {
      if (message.role === "notice" && message.parts.length === 0) continue;
      turns.push({ kind: message.role, message });
      continue;
    }
    const last = turns.at(-1);
    if (last?.kind === "agent") {
      turns[turns.length - 1] = {
        ...last,
        messages: [...last.messages, message]
      };
    } else {
      turns.push({ kind: "agent", id: message.id, messages: [message] });
    }
  }
  return turns;
}

/** Every tool result in the transcript, by tool call id. */
export function resultsById(
  messages: readonly TranscriptMessage[]
): Map<string, ToolResultPart> {
  const results = new Map<string, ToolResultPart>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool-result") results.set(part.id, part);
    }
  }
  return results;
}

export function messageText(message: TranscriptMessage): string {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

// ── Tool call labels ────────────────────────────────────────────────

function isObject(
  value: JsonValue
): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(args: JsonValue, key: string): string | undefined {
  if (!isObject(args)) return undefined;
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function shorten(text: string, max = 60): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > max || text.trim().includes("\n")
    ? `${line.slice(0, max).trimEnd()}…`
    : line;
}

function Mono({ children }: { children: string }) {
  return (
    <span className="font-mono text-[0.9em] text-kumo-default">{children}</span>
  );
}

/** What a browser call did, guessed from its code and result. */
function browserLabel(code: string, running: boolean, screenshot: boolean) {
  if (screenshot) return "Took a screenshot";
  const url = code.match(/https?:\/\/[^\s'"`)]+/)?.[0];
  if (code.includes("browser.assignHost")) {
    return running ? "Pointing an internal host…" : "Pointed an internal host";
  }
  if (url) {
    return (
      <>
        {running ? "Opening " : "Opened "}
        <Mono>{url}</Mono>
      </>
    );
  }
  return running ? "Using the browser…" : "Used the browser";
}

/** One line saying what a tool call did, in the tense of its state. */
function toolLabel(call: ToolCallPart, state: ToolCallState, image: boolean) {
  const running = state === "running";
  const args = call.arguments;
  const path = field(args, "path");
  const verb = (doing: string, done: string) => (running ? doing : done);
  switch (call.name) {
    case "browser":
      return browserLabel(field(args, "code") ?? "", running, image);
    case "exec": {
      const command = field(args, "command");
      return command ? (
        <>
          {verb("Running ", "Ran ")}
          <Mono>{shorten(command)}</Mono>
        </>
      ) : (
        verb("Running a command…", "Ran a command")
      );
    }
    case "read":
    case "write":
    case "edit":
    case "delete":
    case "ls": {
      const verbs = {
        read: ["Reading ", "Read "],
        write: ["Writing ", "Wrote "],
        edit: ["Editing ", "Edited "],
        delete: ["Deleting ", "Deleted "],
        ls: ["Listing ", "Listed "]
      } as const;
      const [doing, done] = verbs[call.name];
      return (
        <>
          {verb(doing, done)}
          <Mono>{path ?? "a file"}</Mono>
        </>
      );
    }
    case "find":
    case "grep": {
      const query = field(args, "pattern") ?? field(args, "query");
      return (
        <>
          {verb("Searching for ", "Searched for ")}
          <Mono>{query ?? "files"}</Mono>
        </>
      );
    }
    default:
      return (
        <>
          {verb("Calling ", "Called ")}
          <Mono>{call.name}</Mono>
        </>
      );
  }
}

/** The call's input, the way a person would write it. */
function toolInput(call: ToolCallPart): string {
  const code = call.name === "browser" ? field(call.arguments, "code") : null;
  if (code) return code;
  const command =
    call.name === "exec" ? field(call.arguments, "command") : undefined;
  if (command) return command;
  return JSON.stringify(call.arguments, null, 2);
}

/** The result's text, pretty-printed when it is JSON. */
function toolOutput(result: ToolResultPart): string | undefined {
  const text = result.content
    .map((content) => (content.type === "text" ? content.text : ""))
    .join("\n")
    .trim();
  if (!text) return undefined;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

// ── Screenshots ─────────────────────────────────────────────────────

export type ZoomImage = { readonly src: string; readonly alt: string };

function imageSrc(image: ImageContent): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

/** A screenshot at a readable size. Click it to see it full size. */
function Screenshot({
  image,
  alt,
  onZoom
}: {
  image: ImageContent;
  alt: string;
  onZoom: (image: ZoomImage) => void;
}) {
  const src = imageSrc(image);
  return (
    <button
      type="button"
      onClick={() => onZoom({ src, alt })}
      aria-label={`Enlarge: ${alt}`}
      className="w-fit cursor-zoom-in overflow-hidden rounded-lg ring-1 ring-kumo-line hover:ring-kumo-brand/60"
    >
      <img
        src={src}
        alt={alt}
        className="block max-h-72 w-auto max-w-full bg-white"
      />
    </button>
  );
}

// ── Messages ────────────────────────────────────────────────────────

function toolState(
  result: ToolResultPart | undefined,
  running: PiRunningTool | undefined,
  turnRunning: boolean
): ToolCallState {
  if (result) return result.error ? "error" : "done";
  if (running || turnRunning) return "running";
  return "interrupted";
}

function ToolCallView({
  call,
  result,
  running,
  turnRunning,
  onZoom
}: {
  call: ToolCallPart;
  result: ToolResultPart | undefined;
  running: PiRunningTool | undefined;
  turnRunning: boolean;
  onZoom: (image: ZoomImage) => void;
}) {
  const state = toolState(result, running, turnRunning);
  const images = (result?.content ?? []).filter(
    (content): content is ImageContent => content.type === "image"
  );
  const output = result ? toolOutput(result) : undefined;
  const label = toolLabel(call, state, images.length > 0);
  const tail = running?.output.trim();
  return (
    <ToolCall
      label={state === "interrupted" ? <>{label} · no result</> : label}
      state={state}
      input={toolInput(call)}
      output={result?.error ? undefined : output}
      error={result?.error ? (output ?? "Failed") : undefined}
    >
      {tail ? (
        <pre className="max-h-32 overflow-auto rounded-lg bg-kumo-recessed p-3 font-mono text-xs whitespace-pre-wrap text-kumo-subtle">
          {tail.split("\n").slice(-8).join("\n")}
        </pre>
      ) : null}
      {images.map((image, index) => (
        <Screenshot
          key={index}
          image={image}
          alt="Screenshot from the agent's browser"
          onZoom={onZoom}
        />
      ))}
    </ToolCall>
  );
}

/** A tool result whose call isn't in the transcript, e.g. after a reset. */
function OrphanResult({
  result,
  onZoom
}: {
  result: ToolResultPart;
  onZoom: (image: ZoomImage) => void;
}) {
  return (
    <ToolCallView
      call={{
        type: "tool-call",
        id: result.id,
        name: result.name,
        arguments: {}
      }}
      result={result}
      running={undefined}
      turnRunning={false}
      onZoom={onZoom}
    />
  );
}

/** Everything the agent did in one turn: text, reasoning, and tool calls. */
export function AgentTurn({
  messages,
  results,
  runningTools,
  turnRunning,
  streaming,
  onZoom
}: {
  messages: readonly TranscriptMessage[];
  results: Map<string, ToolResultPart>;
  runningTools: readonly PiRunningTool[];
  /** True while the session runs and this is the last turn. */
  turnRunning: boolean;
  /** True while the last message in `messages` is streaming. */
  streaming: boolean;
  onZoom: (image: ZoomImage) => void;
}) {
  const calls = new Set(
    messages.flatMap((message) =>
      message.parts.flatMap((part) =>
        part.type === "tool-call" ? part.id : []
      )
    )
  );
  return (
    <AssistantMessage>
      {messages.map((message, messageIndex) => {
        const live = streaming && messageIndex === messages.length - 1;
        const lastText = message.parts.reduce(
          (last, part, index) => (part.type === "text" ? index : last),
          -1
        );
        return [
          ...message.parts.map((part, index) => {
            const key = `${message.id}-${index}`;
            switch (part.type) {
              case "text":
                return part.text.trim() ? (
                  <Markdown
                    key={key}
                    text={part.text}
                    streaming={live && index === lastText}
                  />
                ) : null;
              case "thinking":
                return (
                  <Reasoning
                    key={key}
                    text={part.text}
                    streaming={live && index === message.parts.length - 1}
                  />
                );
              case "tool-call":
                return (
                  <ToolCallView
                    key={key}
                    call={part}
                    result={results.get(part.id)}
                    running={runningTools.find(
                      (tool) => tool.callId === part.id
                    )}
                    turnRunning={turnRunning}
                    onZoom={onZoom}
                  />
                );
              case "tool-result":
                return calls.has(part.id) ? null : (
                  <OrphanResult key={key} result={part} onZoom={onZoom} />
                );
              case "image":
                return (
                  <Screenshot
                    key={key}
                    image={part}
                    alt="Image from the agent"
                    onZoom={onZoom}
                  />
                );
            }
          }),
          message.error ? (
            <TurnError key={`${message.id}-error`} message={message.error} />
          ) : null
        ];
      })}
    </AssistantMessage>
  );
}

export function TurnError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 text-sm text-kumo-danger"
    >
      <WarningCircleIcon size={16} className="mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

export { UserMessage };
