import { useState, useEffect, useRef } from "react";
import { isToolUIPart, getToolName } from "ai";
import type { UIMessage } from "ai";
import { Badge, Empty, Surface, Text } from "@cloudflare/kumo";
import {
  GearIcon,
  TerminalIcon,
  CaretDownIcon,
  FileIcon,
  PencilSimpleIcon,
  DownloadSimpleIcon
} from "@phosphor-icons/react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import type { OpenCodeRunOutput } from "@cloudflare/agents-opencode";

/** Safely coerce a value to a renderable string. */
function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => safeString((part as { type: "text"; text: unknown }).text))
    .join("");
}

/** Map tool identifiers to display-friendly names. */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  opencode: "OpenCode"
};

function displayToolName(toolName: string): string {
  return TOOL_DISPLAY_NAMES[toolName] ?? toolName;
}

/**
 * Renders an array of message parts (text, reasoning, tool calls).
 * Used both for top-level chat messages and for sub-conversation
 * messages inside the opencode tool output.
 *
 * @param maxWidth - CSS max-width class for bubbles (default: "max-w-full")
 * @param isLastAssistant - true when this is the last assistant message
 *   in the chat (enables streaming animation on the final text part)
 * @param onOpenCodeOutput - optional callback to render the opencode tool's
 *   output-available state as a sub-conversation instead of raw JSON
 */
function MessageParts({
  parts,
  isStreaming = false,
  maxWidth = "max-w-full",
  isLastAssistant = false,
  compact = false,
  onOpenCodeOutput
}: {
  parts: Array<Record<string, unknown>>;
  isStreaming?: boolean;
  maxWidth?: string;
  isLastAssistant?: boolean;
  compact?: boolean;
  onOpenCodeOutput?: (
    toolCallId: string,
    output: OpenCodeRunOutput,
    preliminary: boolean
  ) => React.ReactNode;
}) {
  return (
    <>
      {parts.map((part, partIndex) => {
        if (part.type === "text") {
          const text = safeString(part.text);
          if (!text) return null;

          // Animate the last text part of the last assistant message
          const isLastTextPart = parts
            .slice(partIndex + 1)
            .every((p) => p.type !== "text");
          const animate = isStreaming && isLastAssistant && isLastTextPart;

          return (
            <div key={partIndex} className="flex justify-start">
              <div
                className={`${maxWidth} px-4 py-2.5 rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed`}
              >
                <Streamdown
                  className="sd-theme"
                  plugins={{ code }}
                  controls={false}
                  isAnimating={animate}
                >
                  {text}
                </Streamdown>
              </div>
            </div>
          );
        }

        if (part.type === "reasoning") {
          const text = safeString(part.text);
          if (!text) return null;

          if (compact) {
            return (
              <div
                key={partIndex}
                className="whitespace-pre-wrap text-kumo-subtle italic"
              >
                {text}
              </div>
            );
          }

          return (
            <div key={partIndex} className="flex justify-start">
              <Surface
                className={`${maxWidth} px-4 py-2.5 rounded-xl ring ring-kumo-line opacity-70`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <GearIcon size={14} className="text-kumo-inactive" />
                  <Text size="xs" variant="secondary" bold>
                    Thinking
                  </Text>
                </div>
                <div className="whitespace-pre-wrap text-xs text-kumo-subtle italic">
                  {text}
                </div>
              </Surface>
            </div>
          );
        }

        // Handle both dynamic-tool and tool-* parts
        if (
          isToolUIPart(part as Parameters<typeof isToolUIPart>[0]) ||
          part.type === "dynamic-tool"
        ) {
          const toolName =
            part.type === "dynamic-tool"
              ? (part.toolName as string)
              : getToolName(part as Parameters<typeof getToolName>[0]);
          const state = part.state as string;
          const toolCallId = (part.toolCallId as string) ?? `tool-${partIndex}`;

          if (state === "output-available") {
            // Delegate opencode tool rendering to the caller if a handler is provided
            if (toolName === "opencode" && onOpenCodeOutput) {
              const output = part.output as OpenCodeRunOutput | undefined;
              // Guard: only render as sub-conversation if output looks valid
              if (
                output &&
                typeof output === "object" &&
                "messages" in output
              ) {
                return onOpenCodeOutput(
                  toolCallId,
                  output,
                  !!(part.preliminary as boolean | undefined)
                );
              }
            }

            const inputStr = part.input
              ? JSON.stringify(part.input, null, 2)
              : null;
            const outputStr = part.output
              ? JSON.stringify(part.output, null, 2)
              : null;
            return (
              <div key={toolCallId} className="flex justify-start">
                <Surface
                  className={`${maxWidth} px-4 py-2.5 rounded-xl ring ring-kumo-line`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <GearIcon size={14} className="text-kumo-inactive" />
                    <Text size="xs" variant="secondary" bold>
                      {displayToolName(toolName)}
                    </Text>
                    <Badge variant="secondary">Done</Badge>
                  </div>
                  <div className="space-y-1.5">
                    {inputStr && (
                      <div>
                        <span className="block text-[10px] text-kumo-inactive uppercase tracking-wide mb-0.5">
                          Input
                        </span>
                        <div className="font-mono max-h-28 overflow-y-auto bg-kumo-elevated rounded px-2 py-1">
                          <Text size="xs" variant="secondary">
                            {inputStr}
                          </Text>
                        </div>
                      </div>
                    )}
                    {outputStr && (
                      <div>
                        <span className="block text-[10px] text-kumo-inactive uppercase tracking-wide mb-0.5">
                          Output
                        </span>
                        <div className="font-mono max-h-32 overflow-y-auto">
                          <Text size="xs" variant="secondary">
                            {outputStr}
                          </Text>
                        </div>
                      </div>
                    )}
                  </div>
                </Surface>
              </div>
            );
          }

          if (state === "output-error") {
            return (
              <div key={toolCallId} className="flex justify-start">
                <Surface
                  className={`${maxWidth} px-4 py-2.5 rounded-xl ring ring-kumo-line`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <GearIcon size={14} className="text-kumo-inactive" />
                    <Text size="xs" variant="secondary" bold>
                      {displayToolName(toolName)}
                    </Text>
                    <Badge variant="destructive">Error</Badge>
                  </div>
                  <Text size="xs" variant="error">
                    {safeString(part.errorText) || "Tool failed"}
                  </Text>
                </Surface>
              </div>
            );
          }

          if (state === "input-available" || state === "input-streaming") {
            const inputStr =
              part.input && Object.keys(part.input as object).length > 0
                ? JSON.stringify(part.input, null, 2)
                : null;
            return (
              <div key={toolCallId} className="flex justify-start">
                <Surface
                  className={`${maxWidth} px-4 py-2.5 rounded-xl ring ring-kumo-line`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <GearIcon
                      size={14}
                      className="text-kumo-inactive animate-spin"
                    />
                    <Text size="xs" variant="secondary" bold>
                      {displayToolName(toolName)}
                    </Text>
                    <Text size="xs" variant="secondary">
                      running…
                    </Text>
                  </div>
                  {inputStr && (
                    <div className="font-mono max-h-28 overflow-y-auto bg-kumo-elevated rounded px-2 py-1 mt-1">
                      <Text size="xs" variant="secondary">
                        {inputStr}
                      </Text>
                    </div>
                  )}
                </Surface>
              </div>
            );
          }

          return null;
        }

        return null;
      })}
    </>
  );
}

/**
 * Renders the opencode tool's output as a collapsible sub-conversation.
 * Shows the OpenCode agent's messages (text + tool calls) inline,
 * auto-expanding while streaming and auto-scrolling to the bottom.
 */
function OpenCodeSubConversation({
  output,
  isStreaming,
  sandboxId
}: {
  output: OpenCodeRunOutput;
  isStreaming: boolean;
  sandboxId?: string;
}) {
  const [expanded, setExpanded] = useState(isStreaming);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-expand while streaming, allow collapse after
  useEffect(() => {
    if (isStreaming) setExpanded(true);
  }, [isStreaming]);

  // Auto-scroll to bottom while streaming
  useEffect(() => {
    if (isStreaming && expanded && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  });

  const isError = output.status === "error";
  const isDone = output.status === "complete";
  const statusColor = isError
    ? "text-kumo-danger"
    : isDone
      ? "text-kumo-success"
      : "text-kumo-accent";

  const statusLabel = isError ? "Error" : isDone ? "Done" : "Working\u2026";

  const messageCount = output.messages.length;
  const toolCount = output.messages.reduce(
    (n, msg) =>
      n +
      msg.parts.filter(
        (p) =>
          p.type === "dynamic-tool" ||
          (typeof p.type === "string" && p.type.startsWith("tool-"))
      ).length,
    0
  );
  const filesEdited = output.filesEdited ?? [];
  const diffs = output.diffs ?? [];
  const diagnostics = output.diagnostics ?? [];
  const processes = output.processes ?? [];
  const todos = output.todos ?? [];

  return (
    <div className="flex justify-start">
      <Surface className="max-w-[85%] w-full rounded-xl ring ring-kumo-line overflow-hidden">
        {/* Header */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full px-4 py-2.5 flex items-center gap-2 hover:bg-kumo-elevated transition-colors text-left"
        >
          <GearIcon
            size={14}
            className={
              isStreaming
                ? "text-kumo-accent animate-spin"
                : "text-kumo-inactive"
            }
          />
          <Text size="xs" variant="secondary" bold>
            OpenCode
          </Text>
          {output.modelID && (
            <Text size="xs" variant="secondary">
              ({output.modelID})
            </Text>
          )}
          <span className={`text-xs ${statusColor}`}>{statusLabel}</span>
          {!isStreaming && (
            <span className="text-[10px] text-kumo-inactive ml-auto flex items-center gap-2">
              {filesEdited.length > 0 && (
                <span className="flex items-center gap-0.5">
                  <PencilSimpleIcon size={10} />
                  {filesEdited.length} file{filesEdited.length !== 1 ? "s" : ""}
                </span>
              )}
              {toolCount > 0 &&
                `${toolCount} tool call${toolCount !== 1 ? "s" : ""}`}
            </span>
          )}
          <CaretDownIcon
            size={12}
            className={`text-kumo-inactive transition-transform ${expanded ? "" : "-rotate-90"}`}
          />
        </button>

        {/* Error banner */}
        {isError && output.error && (
          <div className="px-4 py-2 bg-red-50 dark:bg-red-950/30 border-t border-kumo-line">
            <Text size="xs" variant="error">
              {safeString(output.error)}
            </Text>
          </div>
        )}

        {/* Expanded sub-conversation */}
        {expanded && messageCount > 0 && (
          <div
            ref={scrollRef}
            className="border-t border-kumo-line max-h-[500px] overflow-y-auto px-4 py-3 space-y-3 text-sm"
          >
            {output.messages.map((msg) => {
              if (msg.role === "user") {
                const text = msg.parts
                  .filter((p) => p.type === "text")
                  .map((p) => (p as { type: "text"; text: string }).text)
                  .join("");
                if (!text) return null;
                return (
                  <div
                    key={msg.id}
                    className="px-3 py-1.5 rounded-lg bg-kumo-contrast/5 border border-kumo-line text-xs text-kumo-subtle italic"
                  >
                    {text}
                  </div>
                );
              }
              return (
                <div key={msg.id} className="space-y-2">
                  <MessageParts
                    parts={msg.parts as Array<Record<string, unknown>>}
                    isStreaming={isStreaming}
                    compact
                  />
                </div>
              );
            })}
          </div>
        )}

        {/* Files changed */}
        {filesEdited.length > 0 && (
          <div className="px-4 py-2 border-t border-kumo-line space-y-1">
            <div className="flex items-center gap-1.5 mb-1">
              <FileIcon size={12} className="text-kumo-inactive" />
              <Text size="xs" variant="secondary" bold>
                Files changed
              </Text>
              {diffs.length > 0 && (
                <span className="text-[10px] text-kumo-inactive">
                  (+{diffs.reduce((n, d) => n + d.additions, 0)}/{"−"}
                  {diffs.reduce((n, d) => n + d.deletions, 0)})
                </span>
              )}
            </div>
            {filesEdited.map((file) => {
              const diff = diffs.find((d) => d.file === file);
              const statusBadge =
                diff?.status === "added"
                  ? "text-green-600 dark:text-green-400"
                  : diff?.status === "deleted"
                    ? "text-red-600 dark:text-red-400"
                    : "text-kumo-subtle";
              return (
                <div
                  key={file}
                  className="flex items-center gap-2 text-[11px] font-mono"
                >
                  <span className={statusBadge}>
                    {diff?.status === "added"
                      ? "+"
                      : diff?.status === "deleted"
                        ? "−"
                        : "~"}
                  </span>
                  <span className="text-kumo-default truncate">{file}</span>
                  {diff && (
                    <span className="text-[10px] text-kumo-inactive shrink-0">
                      <span className="text-green-600 dark:text-green-400">
                        +{diff.additions}
                      </span>{" "}
                      <span className="text-red-600 dark:text-red-400">
                        −{diff.deletions}
                      </span>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Processes */}
        {processes.length > 0 && (
          <div className="px-4 py-2 border-t border-kumo-line space-y-1">
            <Text size="xs" variant="secondary" bold>
              Processes
            </Text>
            {processes.map((proc) => (
              <div
                key={proc.id}
                className="flex items-center gap-2 text-[11px] font-mono"
              >
                <span
                  className={
                    proc.status === "running"
                      ? "text-kumo-accent"
                      : proc.exitCode === 0
                        ? "text-kumo-subtle"
                        : "text-red-600 dark:text-red-400"
                  }
                >
                  {proc.status === "running"
                    ? "●"
                    : proc.exitCode === 0
                      ? "✓"
                      : "✗"}
                </span>
                <span className="text-kumo-default truncate">
                  {proc.command}
                  {proc.args.length > 0 ? ` ${proc.args.join(" ")}` : ""}
                </span>
                {proc.status === "exited" && proc.exitCode !== 0 && (
                  <span className="text-[10px] text-red-600 dark:text-red-400 shrink-0">
                    exit {proc.exitCode}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Diagnostics */}
        {diagnostics.length > 0 && (
          <div className="px-4 py-2 border-t border-kumo-line space-y-1">
            <Text size="xs" variant="secondary" bold>
              Diagnostics
            </Text>
            {diagnostics.map((diag, i) => (
              <div
                key={`${diag.path}-${i}`}
                className="flex items-center gap-2 text-[11px] font-mono"
              >
                <span className="text-kumo-warning">⚠</span>
                <span className="text-kumo-default truncate">{diag.path}</span>
                <span className="text-[10px] text-kumo-inactive shrink-0">
                  {diag.serverID}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Todos */}
        {todos.length > 0 && (
          <div className="px-4 py-2 border-t border-kumo-line space-y-1">
            <Text size="xs" variant="secondary" bold>
              Tasks
            </Text>
            {todos.map((todo, i) => (
              <div key={i} className="flex items-center gap-2 text-[11px]">
                <span
                  className={
                    todo.status === "done" || todo.status === "completed"
                      ? "text-kumo-success"
                      : "text-kumo-subtle"
                  }
                >
                  {todo.status === "done" || todo.status === "completed"
                    ? "✓"
                    : "○"}
                </span>
                <span className="text-kumo-default">{todo.content}</span>
                {todo.priority && todo.priority !== "normal" && (
                  <span className="text-[10px] text-kumo-inactive">
                    {todo.priority}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Summary */}
        {isDone && output.summary && (
          <div className="px-4 py-2 border-t border-kumo-line bg-kumo-elevated">
            <Text size="xs" variant="secondary">
              {safeString(output.summary)}
            </Text>
          </div>
        )}
      </Surface>
    </div>
  );
}

interface ChatMessagesProps {
  messages: UIMessage[];
  isStreaming: boolean;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  sandboxId?: string;
}

export function ChatMessages({
  messages,
  isStreaming,
  messagesEndRef,
  sandboxId
}: ChatMessagesProps) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
        {messages.length === 0 && (
          <Empty
            icon={<TerminalIcon size={32} />}
            title="Start building"
            description={
              'Try "Build me a todo app" or "Create a REST API with Hono"'
            }
          />
        )}

        {messages.map((message, index) => {
          const isUser = message.role === "user";
          const isLastAssistant =
            message.role === "assistant" && index === messages.length - 1;

          if (isUser) {
            return (
              <div key={message.id} className="flex justify-end">
                <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                  {getMessageText(message)}
                </div>
              </div>
            );
          }

          return (
            <div key={message.id} className="space-y-2">
              <MessageParts
                parts={message.parts as Array<Record<string, unknown>>}
                isStreaming={isStreaming}
                maxWidth="max-w-[85%]"
                isLastAssistant={isLastAssistant}
                onOpenCodeOutput={(toolCallId, output, preliminary) => (
                  <div key={toolCallId} className="space-y-2">
                    <OpenCodeSubConversation
                      output={output}
                      isStreaming={preliminary}
                      sandboxId={sandboxId}
                    />
                    {output.status === "complete" &&
                      output.outputFile &&
                      sandboxId && (
                        <div className="flex justify-start">
                          <a
                            href={`/artifacts/${encodeURIComponent(sandboxId)}${output.outputFile}`}
                            download
                            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-kumo-accent/10 hover:bg-kumo-accent/20 transition-colors text-kumo-accent text-sm font-medium"
                          >
                            <DownloadSimpleIcon size={16} />
                            Download {output.outputFile.split("/").pop()}
                          </a>
                        </div>
                      )}
                  </div>
                )}
              />
            </div>
          );
        })}

        <div ref={messagesEndRef} />
      </div>
    </div>
  );
}
