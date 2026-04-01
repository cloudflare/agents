import { useState, useEffect, useRef } from "react";
import { isToolUIPart, getToolName } from "ai";
import type { UIMessage } from "ai";
import { Badge, Empty, Surface, Text } from "@cloudflare/kumo";
import { GearIcon, TerminalIcon, CaretDownIcon } from "@phosphor-icons/react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import type { CoderToolOutput } from "../server";

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { type: "text"; text: string }).text)
    .join("");
}

// ── Shared message part renderer ──────────────────────────────────────

/**
 * Renders an array of message parts (text, reasoning, tool calls).
 * Used both for top-level chat messages and for sub-conversation
 * messages inside the coder tool output.
 *
 * @param maxWidth - CSS max-width class for bubbles (default: "max-w-full")
 * @param isLastAssistant - true when this is the last assistant message
 *   in the chat (enables streaming animation on the final text part)
 * @param onCoderOutput - optional callback to render the coder tool's
 *   output-available state as a sub-conversation instead of raw JSON
 */
function MessageParts({
  parts,
  isStreaming = false,
  maxWidth = "max-w-full",
  isLastAssistant = false,
  onCoderOutput
}: {
  parts: Array<Record<string, unknown>>;
  isStreaming?: boolean;
  maxWidth?: string;
  isLastAssistant?: boolean;
  onCoderOutput?: (
    toolCallId: string,
    output: CoderToolOutput,
    preliminary: boolean
  ) => React.ReactNode;
}) {
  return (
    <>
      {parts.map((part, partIndex) => {
        if (part.type === "text") {
          const text = part.text as string;
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
          const text = part.text as string;
          if (!text) return null;
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
            // Delegate coder tool rendering to the caller if a handler is provided
            if (toolName === "coder" && onCoderOutput) {
              return onCoderOutput(
                toolCallId,
                part.output as CoderToolOutput,
                !!(part.preliminary as boolean | undefined)
              );
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
                      {toolName}
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
                      {toolName}
                    </Text>
                    <Badge variant="destructive">Error</Badge>
                  </div>
                  <Text size="xs" variant="error">
                    {(part.errorText as string) ?? "Tool failed"}
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
                      {toolName}
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

// ── Coder sub-conversation ───────────────────────────────────────────

/**
 * Renders the coder tool's output as a collapsible sub-conversation.
 * Shows the OpenCode agent's messages (text + tool calls) inline,
 * auto-expanding while streaming and auto-scrolling to the bottom.
 */
function CoderSubConversation({
  output,
  isStreaming
}: {
  output: CoderToolOutput;
  isStreaming: boolean;
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
            Coding Agent
          </Text>
          <span className={`text-xs ${statusColor}`}>{statusLabel}</span>
          {!isStreaming && (
            <span className="text-[10px] text-kumo-inactive ml-auto">
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
              {output.error}
            </Text>
          </div>
        )}

        {/* Expanded sub-conversation */}
        {expanded && messageCount > 0 && (
          <div
            ref={scrollRef}
            className="border-t border-kumo-line max-h-[500px] overflow-y-auto px-4 py-3 space-y-3"
          >
            {output.messages.map((msg) => (
              <div key={msg.id} className="space-y-2">
                <MessageParts
                  parts={msg.parts as Array<Record<string, unknown>>}
                  isStreaming={isStreaming}
                />
              </div>
            ))}
          </div>
        )}

        {/* Summary */}
        {isDone && output.summary && (
          <div className="px-4 py-2 border-t border-kumo-line bg-kumo-elevated">
            <Text size="xs" variant="secondary">
              {output.summary}
            </Text>
          </div>
        )}
      </Surface>
    </div>
  );
}

// ── Main chat messages component ─────────────────────────────────────

interface ChatMessagesProps {
  messages: UIMessage[];
  isStreaming: boolean;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

export function ChatMessages({
  messages,
  isStreaming,
  messagesEndRef
}: ChatMessagesProps) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
        {messages.length === 0 && (
          <Empty
            icon={<TerminalIcon size={32} />}
            title="Start building"
            description={
              'Try "Create a hello world HTML page" or "Run python3 -c \'print(42)\'"'
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
                onCoderOutput={(toolCallId, output, preliminary) => (
                  <CoderSubConversation
                    key={toolCallId}
                    output={output}
                    isStreaming={preliminary}
                  />
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
