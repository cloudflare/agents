import { useEffect, useState } from "react";
import { Badge, Empty, Text } from "@cloudflare/kumo";
import { StackIcon } from "@phosphor-icons/react";
import type { ContextSnapshot, ExoState, Json } from "../kernel/types";
import { formatTime, type AgentCaller } from "./bits";

interface RawMessage {
  role?: string;
  content?: Json;
}

function contentToText(content: Json | undefined): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content, null, 2) ?? "";
  } catch {
    return String(content);
  }
}

const ROLE_VARIANT: Record<string, "primary" | "secondary"> = {
  user: "primary",
  assistant: "secondary",
  tool: "secondary",
  system: "secondary"
};

/**
 * The "Context" tab — the exact raw context assembled for the model at the
 * start of the most recent turn: kernel system prompt (including the live
 * identity file), the pruned message array, and the tool surface. Refreshes
 * whenever the journal moves (i.e. after every turn or tool call).
 */
export function ContextTab({
  agent,
  state,
  isConnected
}: {
  agent: AgentCaller;
  state: ExoState;
  isConnected: boolean;
}) {
  const [snapshot, setSnapshot] = useState<ContextSnapshot | null>(null);

  useEffect(() => {
    if (!isConnected) return;
    let cancelled = false;
    void agent
      .call("getContextSnapshot")
      .then((result) => {
        if (!cancelled) setSnapshot(result as ContextSnapshot | null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [agent, isConnected, state.journalTail]);

  if (!snapshot) {
    return (
      <Empty
        icon={<StackIcon size={32} />}
        title="No context captured yet"
        description="Send a message — the kernel records the exact system prompt, message array, and tool surface it hands the model each turn."
      />
    );
  }

  const messages = (
    Array.isArray(snapshot.messages) ? snapshot.messages : []
  ) as RawMessage[];
  const overTarget =
    snapshot.contextPolicy &&
    snapshot.estimatedTokens > snapshot.contextPolicy.tokenTarget;

  return (
    <div className="h-full overflow-y-auto">
      {/* Capture header */}
      <div className="px-3 py-2 border-b border-kumo-line flex items-center gap-2 flex-wrap">
        <Badge variant="primary">model: {snapshot.model}</Badge>
        <Badge variant="secondary">{snapshot.source} turn</Badge>
        <Badge variant={overTarget ? "destructive" : "secondary"}>
          ~{snapshot.estimatedTokens} / {snapshot.contextPolicy?.tokenTarget}{" "}
          tok{overTarget ? " — over target" : ""}
        </Badge>
        {snapshot.memoryChars > 0 && (
          <Badge variant="secondary">memory: {snapshot.memoryChars}ch</Badge>
        )}
        <span className="text-[10px] text-kumo-inactive ml-auto">
          captured {formatTime(snapshot.ts)}
        </span>
      </div>

      {/* System prompt */}
      <div className="px-3 py-2 border-b border-kumo-line">
        <Text size="xs" bold>
          System prompt ({snapshot.system.length} chars — kernel briefing + live
          identity.md)
        </Text>
      </div>
      <pre className="px-3 py-2 border-b border-kumo-line text-[11px] leading-relaxed font-mono text-kumo-default whitespace-pre-wrap break-words bg-kumo-base">
        {snapshot.system}
      </pre>

      {/* Messages */}
      <div className="px-3 py-2 border-b border-kumo-line">
        <Text size="xs" bold>
          Messages ({messages.length}, after pruning — policy keeps at most{" "}
          {snapshot.contextPolicy?.keepMessages})
        </Text>
      </div>
      {messages.map((message, index) => (
        <div key={index} className="px-3 py-2 border-b border-kumo-line">
          <div className="flex items-center gap-2 mb-1">
            <Badge variant={ROLE_VARIANT[message.role ?? ""] ?? "secondary"}>
              {message.role ?? "?"}
            </Badge>
            <span className="text-[10px] text-kumo-inactive">
              {contentToText(message.content).length} chars
            </span>
          </div>
          <pre className="text-[11px] leading-relaxed font-mono text-kumo-subtle whitespace-pre-wrap break-words">
            {contentToText(message.content)}
          </pre>
        </div>
      ))}

      {/* Tool surface */}
      <div className="px-3 py-2 border-b border-kumo-line">
        <Text size="xs" bold>
          Tool surface ({snapshot.tools.length})
        </Text>
      </div>
      {snapshot.tools.map((tool) => (
        <div
          key={tool.name}
          className="px-3 py-1.5 border-b border-kumo-line flex items-start gap-2"
        >
          <span className="text-[11px] font-mono text-kumo-default shrink-0">
            {tool.name}
          </span>
          <span className="text-[10px] text-kumo-inactive">
            {tool.description}
          </span>
        </div>
      ))}
      <div className="px-3 py-2">
        <Text size="xs" variant="secondary">
          This is the exact context handed to the model at the last turn start.
          The system prompt is rebuilt from the live harness every turn — edit
          /harness/identity.md and it changes here next turn.
        </Text>
      </div>
    </div>
  );
}
