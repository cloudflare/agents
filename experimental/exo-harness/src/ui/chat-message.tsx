import { Badge, Surface, Text } from "@cloudflare/kumo";
import { GearIcon } from "@phosphor-icons/react";
import { isToolUIPart, getToolName } from "ai";
import type { UIMessage } from "ai";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";

export function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { type: "text"; text: string }).text)
    .join("");
}

/**
 * Renders one assistant message: parts in chronological order — text via
 * Streamdown, reasoning muted, tools with input/output/error states.
 */
export function AssistantMessage({
  message,
  isLastAssistant,
  isStreaming
}: {
  message: UIMessage;
  isLastAssistant: boolean;
  isStreaming: boolean;
}) {
  return (
    <div className="space-y-2">
      {message.parts.map((part, partIndex) => {
        if (part.type === "text") {
          if (!part.text) return null;
          const isLastTextPart = message.parts
            .slice(partIndex + 1)
            .every((p) => p.type !== "text");
          return (
            // biome-ignore lint: stable order
            <div key={partIndex} className="flex justify-start">
              <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                <Streamdown
                  className="sd-theme"
                  plugins={{ code }}
                  controls={false}
                  isAnimating={isLastAssistant && isLastTextPart && isStreaming}
                >
                  {part.text}
                </Streamdown>
              </div>
            </div>
          );
        }

        if (part.type === "reasoning") {
          if (!part.text) return null;
          return (
            // biome-ignore lint: stable order
            <div key={partIndex} className="flex justify-start">
              <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line opacity-70">
                <div className="flex items-center gap-2 mb-1">
                  <GearIcon size={14} className="text-kumo-inactive" />
                  <Text size="xs" variant="secondary" bold>
                    Thinking
                  </Text>
                </div>
                <div className="whitespace-pre-wrap text-xs text-kumo-subtle italic">
                  {part.text}
                </div>
              </Surface>
            </div>
          );
        }

        if (!isToolUIPart(part)) return null;
        const toolName = getToolName(part);

        if (part.state === "output-available") {
          return (
            <div key={part.toolCallId} className="flex justify-start">
              <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
                <div className="flex items-center gap-2 mb-2">
                  <GearIcon size={14} className="text-kumo-inactive" />
                  <Text size="xs" variant="secondary" bold>
                    {toolName}
                  </Text>
                  <Badge variant="secondary">Done</Badge>
                </div>
                <div className="space-y-1.5">
                  <div>
                    <span className="block text-[10px] text-kumo-inactive uppercase tracking-wide mb-0.5">
                      Input
                    </span>
                    <div className="font-mono max-h-28 overflow-y-auto bg-kumo-elevated rounded px-2 py-1">
                      <Text size="xs" variant="secondary">
                        {JSON.stringify(part.input, null, 2)}
                      </Text>
                    </div>
                  </div>
                  <div>
                    <span className="block text-[10px] text-kumo-inactive uppercase tracking-wide mb-0.5">
                      Output
                    </span>
                    <div className="font-mono max-h-32 overflow-y-auto">
                      <Text size="xs" variant="secondary">
                        {JSON.stringify(part.output, null, 2)}
                      </Text>
                    </div>
                  </div>
                </div>
              </Surface>
            </div>
          );
        }

        if (part.state === "output-error") {
          const errorText = (part as { errorText?: string }).errorText;
          return (
            <div key={part.toolCallId} className="flex justify-start">
              <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
                <div className="flex items-center gap-2 mb-2">
                  <GearIcon size={14} className="text-kumo-inactive" />
                  <Text size="xs" variant="secondary" bold>
                    {toolName}
                  </Text>
                  <Badge variant="destructive">Error</Badge>
                </div>
                <pre className="font-mono text-xs text-red-500 bg-red-500/10 border border-red-500/20 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                  {errorText ?? "Tool execution failed"}
                </pre>
              </Surface>
            </div>
          );
        }

        if (
          part.state === "input-available" ||
          part.state === "input-streaming"
        ) {
          const inputStr =
            part.input && Object.keys(part.input).length > 0
              ? JSON.stringify(part.input, null, 2)
              : null;
          return (
            <div key={part.toolCallId} className="flex justify-start">
              <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
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
      })}
    </div>
  );
}
