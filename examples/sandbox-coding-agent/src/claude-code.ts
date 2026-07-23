import {
  parseSSEStream,
  type LogEvent,
  type Sandbox
} from "@cloudflare/sandbox";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
  type UIMessageChunk
} from "ai";
import { snapshotDiff, type WorkspaceDiff } from "./diff";

/**
 * Everything one Claude Code turn needs. The container and working directory
 * are owned by the `ClaudeCodeAgent` Durable Object; the runtime only borrows
 * them for the turn and reports back through the callbacks.
 */
export interface ClaudeRunContext {
  /** The warm container for this coding agent. */
  sandbox: Sandbox;
  /** Absolute path of the checked-out repo inside the container. */
  workDir: string;
  /** The task to work on (the latest user message). */
  prompt: string;
  /** Aborted when the run is cancelled or the DO is evicted. */
  abortSignal?: AbortSignal;
  /** Claude owns its native session; we persist its id to `--resume` it. */
  loadSessionId(): string | undefined;
  saveSessionId(id: string): void;
  /** Surface coarse progress to the orchestrator's UI (no-op when standalone). */
  reportProgress(progress: {
    phase?: string;
    message?: string;
    fraction?: number;
  }): void;
  /** Called once the turn finishes with the diff it produced. */
  onResult(result: WorkspaceDiff): void;
}

/**
 * Drives one Claude Code turn inside the container. The CLI runs its *own*
 * agentic loop headless (`-p`) with `stream-json` output; we tail its stdout
 * and project its newline-delimited JSON events into AI SDK `UIMessage` chunks
 * so the orchestrator (and any drill-in view) renders it like any other chat.
 *
 * Claude owns its native session, so each turn `--resume`s it rather than
 * holding a long-lived interactive process. The DO keeps the container warm.
 */
export async function runClaudeCode(ctx: ClaudeRunContext): Promise<Response> {
  const { sandbox, workDir, abortSignal, prompt } = ctx;

  // Reuse the native Claude session across turns so it keeps its own context.
  let sessionId = ctx.loadSessionId();
  const sessionFlag = sessionId
    ? `--resume ${sessionId}`
    : `--session-id ${(sessionId = crypto.randomUUID())}`;
  ctx.saveSessionId(sessionId);

  ctx.reportProgress({ phase: "starting", message: "Launching Claude Code…" });

  const command = [
    'claude -p "$PROMPT"',
    "--output-format stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode bypassPermissions",
    sessionFlag
  ].join(" ");

  const proc = await sandbox.startProcess(command, {
    cwd: workDir,
    env: {
      PROMPT: prompt,
      // The CLI requires a key to boot, but it never reaches Anthropic: the
      // Sandbox intercepts the (default) api.anthropic.com egress and routes it
      // through the AI Gateway binding, which authenticates via the account.
      ANTHROPIC_API_KEY: "cf-aig-placeholder",
      // The container runs as root, where Claude Code refuses
      // `--permission-mode bypassPermissions` unless it knows it's sandboxed.
      IS_SANDBOX: "1"
    }
  });

  abortSignal?.addEventListener("abort", () => {
    proc.kill().catch(() => {});
  });

  const logs = await sandbox.streamProcessLogs(proc.id);

  const stream = createUIMessageStream<UIMessage>({
    onError: (error) =>
      error instanceof Error ? error.message : "Claude Code run failed.",
    execute: async ({ writer }) => {
      writer.write({ type: "start" });
      const mapper = new ClaudeStreamMapper(
        writer,
        (id) => {
          sessionId = id;
          ctx.saveSessionId(id);
        },
        (toolName) =>
          ctx.reportProgress({
            phase: "working",
            message: `Running ${toolName}…`
          })
      );

      let buffer = "";
      let stderr = "";
      let exitCode: number | undefined;
      for await (const log of parseSSEStream<LogEvent>(logs, abortSignal)) {
        if (log.type === "stdout") {
          buffer += log.data;
          // Claude emits one JSON event per line; chunks may straddle lines.
          let newline = buffer.indexOf("\n");
          while (newline !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) mapper.handleLine(line);
            newline = buffer.indexOf("\n");
          }
        } else if (log.type === "stderr") {
          stderr += log.data;
        } else if (log.type === "exit") {
          exitCode = log.exitCode;
        } else if (log.type === "error") {
          throw new Error(log.data || "Claude Code process error.");
        }
      }
      if (buffer.trim()) mapper.handleLine(buffer.trim());
      mapper.flush();

      // Surface failures the CLI reports out-of-band. Without this, a Claude
      // error (e.g. a bad upstream response) yields an empty turn that looks
      // like "no output, no changes" — impossible to debug from the UI.
      const failure = mapper.failure();
      if (failure || (exitCode !== undefined && exitCode !== 0)) {
        const detail = failure ?? `Claude Code exited with code ${exitCode}.`;
        const tail = stderr.trim().split("\n").slice(-12).join("\n");
        writer.write({ type: "text-start", id: "error" });
        writer.write({
          type: "text-delta",
          id: "error",
          delta:
            `\n\n**Claude Code error**\n\n${detail}` +
            (tail ? `\n\n\`\`\`\n${tail}\n\`\`\`` : "")
        });
        writer.write({ type: "text-end", id: "error" });
      }

      // Snapshot the diff the run produced: hand it to the agent (so it can be
      // returned as the agent-tool output) and append it to the message so it
      // renders inline wherever this stream is shown.
      ctx.reportProgress({ phase: "diffing", message: "Capturing diff…" });
      const result = await snapshotDiff(sandbox, workDir);
      ctx.onResult(result);
      if (result.diff.trim()) {
        writer.write({ type: "text-start", id: "diff" });
        writer.write({
          type: "text-delta",
          id: "diff",
          delta: `\n\n**Diff**\n\n\`\`\`diff\n${result.diff}\n\`\`\``
        });
        writer.write({ type: "text-end", id: "diff" });
      }

      writer.write({ type: "finish" });
    }
  });

  return createUIMessageStreamResponse({ stream });
}

type Writer = { write(chunk: UIMessageChunk): void };

type BlockKind = "text" | "reasoning";

/**
 * Translates Claude Code `stream-json` events into AI SDK UI message chunks.
 *
 * Text/reasoning come from token-level `stream_event` deltas; tool calls come
 * from the complete `assistant` messages (full input) and tool results from
 * the follow-up `user` messages — so nothing is double-rendered.
 */
class ClaudeStreamMapper {
  // content-block index -> the kind of streaming block we opened for it
  private openBlocks = new Map<number, BlockKind>();
  private sawText = false;
  private errorText: string | undefined;

  constructor(
    private writer: Writer,
    private onSessionId: (id: string) => void,
    private onToolCall: (toolName: string) => void
  ) {}

  handleLine(line: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // ignore any non-JSON noise
    }

    switch (event.type) {
      case "system":
        if (typeof event.session_id === "string") {
          this.onSessionId(event.session_id);
        }
        break;
      case "stream_event":
        this.handleStreamEvent(event.event as Record<string, unknown>);
        break;
      case "assistant":
        // Only tool_use blocks here — text was already streamed via deltas.
        this.handleAssistantMessage(event.message as Record<string, unknown>);
        break;
      case "user":
        this.handleToolResults(event.message as Record<string, unknown>);
        break;
      case "result":
        if (typeof event.session_id === "string") {
          this.onSessionId(event.session_id);
        }
        // stream-json ends with a `result` event; `is_error` (or an error
        // subtype) means the turn failed and `result` holds the message.
        if (
          event.is_error === true ||
          (typeof event.subtype === "string" && event.subtype !== "success")
        ) {
          this.errorText =
            (typeof event.result === "string" && event.result) ||
            (typeof event.subtype === "string" && event.subtype) ||
            "Claude Code reported an error.";
        }
        break;
    }
  }

  /** A turn-level failure to surface, or undefined on success. */
  failure(): string | undefined {
    if (this.errorText) return this.errorText;
    // A turn that produced no assistant text at all almost always means the
    // CLI failed before it could respond (e.g. an upstream/auth error).
    if (!this.sawText) return "Claude Code produced no output.";
    return undefined;
  }

  /** Token-level Anthropic streaming events (text + thinking). */
  private handleStreamEvent(inner: Record<string, unknown> | undefined): void {
    if (!inner) return;
    const index =
      typeof inner.index === "number" ? (inner.index as number) : undefined;

    if (inner.type === "content_block_start" && index !== undefined) {
      const block = inner.content_block as { type?: string } | undefined;
      if (block?.type === "text") {
        this.openBlocks.set(index, "text");
        this.writer.write({ type: "text-start", id: `b${index}` });
      } else if (block?.type === "thinking") {
        this.openBlocks.set(index, "reasoning");
        this.writer.write({ type: "reasoning-start", id: `b${index}` });
      }
      // tool_use blocks are handled from the complete assistant message.
      return;
    }

    if (inner.type === "content_block_delta" && index !== undefined) {
      const kind = this.openBlocks.get(index);
      const delta = inner.delta as
        | { type?: string; text?: string; thinking?: string }
        | undefined;
      if (kind === "text" && delta?.type === "text_delta" && delta.text) {
        this.sawText = true;
        this.writer.write({
          type: "text-delta",
          id: `b${index}`,
          delta: delta.text
        });
      } else if (
        kind === "reasoning" &&
        delta?.type === "thinking_delta" &&
        delta.thinking
      ) {
        this.writer.write({
          type: "reasoning-delta",
          id: `b${index}`,
          delta: delta.thinking
        });
      }
      return;
    }

    if (inner.type === "content_block_stop" && index !== undefined) {
      const kind = this.openBlocks.get(index);
      if (kind === "text") {
        this.writer.write({ type: "text-end", id: `b${index}` });
      } else if (kind === "reasoning") {
        this.writer.write({ type: "reasoning-end", id: `b${index}` });
      }
      this.openBlocks.delete(index);
    }
  }

  private handleAssistantMessage(
    message: Record<string, unknown> | undefined
  ): void {
    const content = message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type === "tool_use") {
        const toolCallId = String(block.id);
        const toolName = String(block.name);
        this.onToolCall(toolName);
        this.writer.write({
          type: "tool-input-start",
          toolCallId,
          toolName,
          dynamic: true
        });
        this.writer.write({
          type: "tool-input-available",
          toolCallId,
          toolName,
          input: block.input ?? {},
          dynamic: true
        });
      }
    }
  }

  private handleToolResults(
    message: Record<string, unknown> | undefined
  ): void {
    const content = message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type === "tool_result") {
        this.writer.write({
          type: "tool-output-available",
          toolCallId: String(block.tool_use_id),
          output: normalizeToolResult(block.content),
          dynamic: true
        });
      }
    }
  }

  /** Close any blocks left open if the stream ended abruptly. */
  flush(): void {
    for (const [index, kind] of this.openBlocks) {
      this.writer.write({
        type: kind === "text" ? "text-end" : "reasoning-end",
        id: `b${index}`
      });
    }
    this.openBlocks.clear();
  }
}

function normalizeToolResult(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === "object" && "text" in c
          ? String((c as { text: unknown }).text)
          : JSON.stringify(c)
      )
      .join("\n");
  }
  return content ?? "";
}
