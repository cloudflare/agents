/**
 * The scripted conversation the fake model plays, and the checkpoints it can
 * hold or drop at. Shared by the model (which streams it) and whoever drives
 * it (which sends the turns and picks checkpoints).
 *
 * The fake model picks its reply from the request contents, not from a
 * request counter: the newest user message carrying a `[tN]` marker names the
 * turn, and the number of assistant messages after it names the step. A
 * harness that retries a request therefore gets the same reply, and one that
 * keeps an interrupted reply and asks to continue gets the rest of it.
 */

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export type Block =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: { [key: string]: Json } };

export type Step = { blocks: Block[] };

export type Capability = "approvals" | "client-tools";

export type TurnAnswer =
  | { type: "approval"; approved: boolean }
  | { type: "client-result"; output: Json };

export type Turn = {
  id: string;
  text: string;
  steps: Step[];
  /** Harnesses without this capability skip the turn. */
  needs?: Capability;
  /** What the client answers when the turn waits for input. */
  answer?: TurnAnswer;
  /**
   * Send this turn while the named checkpoint of an earlier turn holds, so it
   * arrives while the harness is busy.
   */
  sendWhilePausedAt?: string;
};

/** Server tools that record an execution with the fake model's counter. */
export const RECORDING_TOOLS = ["record", "guarded_record"] as const;
export const CLIENT_TOOL = "client_lookup";

const thinking = (text: string): Block => ({ kind: "thinking", text });
const text = (value: string): Block => ({ kind: "text", text: value });
const record = (key: string): Block => ({
  kind: "tool",
  name: "record",
  input: { key }
});

export const SCRIPT: Turn[] = [
  {
    id: "t1",
    text: "[t1] Say hello.",
    steps: [
      {
        blocks: [
          thinking("The user greets me, so I will greet them back briefly."),
          text("Hello! How can I help you today?")
        ]
      }
    ]
  },
  {
    id: "t2",
    text: "[t2] Record alpha.",
    steps: [
      {
        blocks: [
          thinking("I should call the record tool with the key alpha."),
          text("Recording alpha now."),
          record("alpha")
        ]
      },
      {
        blocks: [
          thinking("The record tool finished, so I can confirm it."),
          text("Recorded alpha.")
        ]
      }
    ]
  },
  {
    id: "t3",
    text: "[t3] Record beta and gamma.",
    steps: [
      {
        blocks: [
          thinking("Two independent records, so I can call both at once."),
          record("beta"),
          record("gamma")
        ]
      },
      {
        blocks: [
          thinking("Both records finished."),
          text("Recorded beta and gamma.")
        ]
      }
    ]
  },
  {
    id: "t4",
    text: "[t4] Record delta, with my approval.",
    needs: "approvals",
    answer: { type: "approval", approved: true },
    steps: [
      {
        blocks: [
          thinking("This record needs the user's approval first."),
          { kind: "tool", name: "guarded_record", input: { key: "delta" } }
        ]
      },
      { blocks: [text("Recorded delta after your approval.")] }
    ]
  },
  {
    id: "t5",
    text: "[t5] Record epsilon, with my approval.",
    needs: "approvals",
    answer: { type: "approval", approved: false },
    steps: [
      {
        blocks: [
          { kind: "tool", name: "guarded_record", input: { key: "epsilon" } }
        ]
      },
      { blocks: [text("Okay, I did not record epsilon.")] }
    ]
  },
  {
    id: "t6",
    text: "[t6] Ask my client for the zeta value.",
    needs: "client-tools",
    answer: { type: "client-result", output: { value: 42 } },
    steps: [
      {
        blocks: [
          thinking("Only the client knows zeta, so I will ask it."),
          { kind: "tool", name: CLIENT_TOOL, input: { key: "zeta" } }
        ]
      },
      { blocks: [text("Your client says zeta is 42.")] }
    ]
  },
  {
    id: "t7",
    text: "[t7] Record eta.",
    steps: [
      {
        blocks: [thinking("One more record, for eta."), record("eta")]
      },
      { blocks: [text("Recorded eta.")] }
    ]
  },
  {
    id: "t8",
    text: "[t8] Then say goodbye.",
    sendWhilePausedAt: "t7.tool.eta",
    steps: [{ blocks: [text("Goodbye!")] }]
  }
];

export function turnsFor(capabilities: readonly Capability[]): Turn[] {
  return SCRIPT.filter(
    (turn) => turn.needs === undefined || capabilities.includes(turn.needs)
  );
}

// ── Checkpoints ──────────────────────────────────────────────────────────

/** Where a checkpoint is observed, which decides how a fault is applied. */
export type CheckpointKind =
  /** The fake model holds its stream here. */
  | "model"
  /** A server tool holds its execution here. */
  | "tool"
  /** The runner applies the fault itself, before acting. */
  | "client";

export type Checkpoint = { id: string; kind: CheckpointKind; turn: string };

export function stepCheckpointPrefix(turn: string, step: number): string {
  return `${turn}.s${step}`;
}

/** Checkpoint ids in the order a stream of the step passes them. */
export function modelCheckpoints(
  turn: string,
  step: number,
  s: Step
): string[] {
  const prefix = stepCheckpointPrefix(turn, step);
  const ids = [`${prefix}.request`];
  s.blocks.forEach((block, i) => {
    ids.push(`${prefix}.b${i}.${block.kind}.start`);
    ids.push(`${prefix}.b${i}.${block.kind}.end`);
  });
  ids.push(`${prefix}.done`);
  return ids;
}

export function toolCheckpoint(turn: string, key: string): string {
  return `${turn}.tool.${key}`;
}

export function checkpointsFor(turns: readonly Turn[]): Checkpoint[] {
  const out: Checkpoint[] = [];
  for (const turn of turns) {
    if (!turn.sendWhilePausedAt) {
      out.push({ id: `${turn.id}.before-send`, kind: "client", turn: turn.id });
    }
    turn.steps.forEach((step, i) => {
      for (const id of modelCheckpoints(turn.id, i, step)) {
        out.push({ id, kind: "model", turn: turn.id });
      }
      // One tool hold per step: the first recording tool call.
      const tool = step.blocks.find(
        (b): b is Extract<Block, { kind: "tool" }> =>
          b.kind === "tool" &&
          (RECORDING_TOOLS as readonly string[]).includes(b.name)
      );
      if (tool && typeof tool.input.key === "string") {
        // Approved tools run after the answer; rejected ones never run.
        if (turn.answer?.type === "approval" && !turn.answer.approved) return;
        out.push({
          id: toolCheckpoint(turn.id, tool.input.key),
          kind: "tool",
          turn: turn.id
        });
      }
    });
    if (turn.answer) {
      out.push({
        id: `${turn.id}.awaiting-input`,
        kind: "client",
        turn: turn.id
      });
    }
  }
  return out;
}

// ── Resolving a request to a step ────────────────────────────────────────

type AnthropicContent =
  | string
  | Array<{ type: string; text?: string; [key: string]: unknown }>;

export type AnthropicRequest = {
  messages?: Array<{ role: string; content: AnthropicContent }>;
  stream?: boolean;
};

function textOf(content: AnthropicContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/**
 * How much of a step an interrupted reply already produced: its visible text
 * so far and its complete tool calls. A harness that keeps the partial reply
 * and asks the model to continue gets the rest of the step.
 */
export type Resume = { text: number; tools: number };

export type Resolved =
  | {
      ok: true;
      turn: Turn;
      step: number;
      resume?: Resume;
      /** Asked to continue a reply that was already complete. */
      nothingLeft?: boolean;
    }
  | { ok: false; reason: string };

const stepText = (step: Step) =>
  step.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("");
const stepTools = (step: Step) =>
  step.blocks.filter((b) => b.kind === "tool").length;

/**
 * What an assistant message produced of a step. Some harnesses send an
 * interrupted reply's reasoning back as text; text the step's thinking starts
 * with is that, not reply text.
 */
function assistantOutput(
  content: AnthropicContent,
  step: Step | undefined
): Resume {
  const parts =
    typeof content === "string" ? [{ type: "text", text: content }] : content;
  const thoughts = (step?.blocks ?? []).flatMap((b) =>
    b.kind === "thinking" ? [b.text] : []
  );
  let text = 0;
  let tools = 0;
  for (const part of parts) {
    if (part.type === "tool_use") tools++;
    if (part.type !== "text" || typeof part.text !== "string") continue;
    const value = part.text;
    if (value && thoughts.some((t) => t.startsWith(value.trimEnd()))) continue;
    text += value.length;
  }
  return { text, tools };
}

/** A user message of plain text with no turn marker: the harness's own. */
function isContinuePrompt(
  message: { role: string; content: AnthropicContent } | undefined
): boolean {
  if (message?.role !== "user") return false;
  const { content } = message;
  if (typeof content !== "string" && content.some((p) => p.type !== "text")) {
    return false;
  }
  const text = textOf(content);
  return text.trim() !== "" && !/\[t\d+\]/.test(text);
}

export function resolveStep(request: AnthropicRequest): Resolved {
  const messages = request.messages ?? [];
  let markerIndex = -1;
  let markerTurn: Turn | undefined;
  messages.forEach((message, index) => {
    if (message.role !== "user") return;
    const markers = [...textOf(message.content).matchAll(/\[(t\d+)\]/g)].map(
      (m) => m[1]
    );
    if (markers.length === 0) return;
    // A message that merges several user inputs answers to the newest.
    const newest = SCRIPT.filter((t) => markers.includes(t.id)).at(-1);
    if (newest) {
      markerIndex = index;
      markerTurn = newest;
    }
  });
  if (!markerTurn) return { ok: false, reason: "no turn marker" };
  // Each assistant message completes a step, unless it stopped short of the
  // step's text and tool calls: then the next ones continue that step.
  let step = 0;
  let done: Resume = { text: 0, tools: 0 };
  let partial = false;
  for (const message of messages.slice(markerIndex + 1)) {
    if (message.role !== "assistant") continue;
    const current = markerTurn.steps[step];
    const output = assistantOutput(message.content, current);
    done = { text: done.text + output.text, tools: done.tools + output.tools };
    if (
      current &&
      (done.text < stepText(current).length || done.tools < stepTools(current))
    ) {
      partial = true;
      continue;
    }
    step++;
    done = { text: 0, tools: 0 };
    partial = false;
  }
  if (step >= markerTurn.steps.length) {
    // A harness that lost the end of a complete reply may ask to continue
    // it. A model would have nothing to add: an empty reply.
    if (isContinuePrompt(messages.at(-1))) {
      const final = markerTurn.steps.length - 1;
      const last = markerTurn.steps[final];
      return {
        ok: true,
        turn: markerTurn,
        step: final,
        resume: { text: stepText(last).length, tools: stepTools(last) },
        nothingLeft: true
      };
    }
    return { ok: false, reason: `${markerTurn.id} has no step ${step}` };
  }
  return { ok: true, turn: markerTurn, step, ...(partial && { resume: done }) };
}

// ── Rendering a step as Anthropic Messages SSE ───────────────────────────

export type StreamItem =
  | { type: "event"; event: string; data: Json }
  | { type: "checkpoint"; id: string };

/** Split text into a few word-aligned deltas, like a token stream. */
export function deltas(value: string, pieces = 3): string[] {
  const words = value.split(/(?<= )/);
  const size = Math.max(1, Math.ceil(words.length / pieces));
  const out: string[] = [];
  for (let i = 0; i < words.length; i += size) {
    out.push(words.slice(i, i + size).join(""));
  }
  return out;
}

export function toolCallId(turn: string, step: number, block: number): string {
  return `toolu_${turn}_s${step}_b${block}`;
}

/** The step as streamed; a resumed step leaves out what was produced. */
function remainingBlocks(
  step: Step,
  resume: Resume | undefined
): Array<{ block: Block; index: number }> {
  if (!resume) return step.blocks.map((block, index) => ({ block, index }));
  let text = resume.text;
  let tools = resume.tools;
  const out: Array<{ block: Block; index: number }> = [];
  step.blocks.forEach((block, index) => {
    // A continuation finishes the visible output; it does not think again.
    if (block.kind === "thinking") return;
    if (block.kind === "tool") {
      if (tools > 0) tools--;
      else out.push({ block, index });
      return;
    }
    if (text >= block.text.length) {
      text -= block.text.length;
      return;
    }
    out.push({ block: { kind: "text", text: block.text.slice(text) }, index });
    text = 0;
  });
  return out;
}

/**
 * `generation` tells apart tool call IDs when the same step is generated
 * again from scratch, as a model mints new IDs on every generation.
 */
export function renderStep(
  turn: Turn,
  stepIndex: number,
  resume?: Resume,
  generation = 0
): StreamItem[] {
  const step = turn.steps[stepIndex];
  const prefix = stepCheckpointPrefix(turn.id, stepIndex);
  const items: StreamItem[] = [{ type: "checkpoint", id: `${prefix}.request` }];
  const event = (name: string, data: Json) =>
    items.push({ type: "event", event: name, data });
  event("message_start", {
    type: "message_start",
    message: {
      id: `msg_${turn.id}_s${stepIndex}${resume ? "_continued" : ""}`,
      type: "message",
      role: "assistant",
      model: "fake-model",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 }
    }
  });
  // Checkpoints keep the step's block numbers; the stream numbers its own.
  remainingBlocks(step, resume).forEach(({ block, index: original }, index) => {
    const at = (edge: string) =>
      items.push({
        type: "checkpoint",
        id: `${prefix}.b${original}.${block.kind}.${edge}`
      });
    const delta = (d: Json) =>
      event("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: d
      });
    if (block.kind === "thinking") {
      event("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "", signature: "" }
      });
      deltas(block.text).forEach((piece, i) => {
        delta({ type: "thinking_delta", thinking: piece });
        if (i === 0) at("start");
      });
      delta({ type: "signature_delta", signature: "Z2F1bnRsZXQ=" });
    } else if (block.kind === "text") {
      event("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" }
      });
      deltas(block.text).forEach((piece, i) => {
        delta({ type: "text_delta", text: piece });
        if (i === 0) at("start");
      });
    } else {
      event("content_block_start", {
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: `${toolCallId(turn.id, stepIndex, original)}${generation ? `_g${generation}` : ""}`,
          name: block.name,
          input: {}
        }
      });
      deltas(JSON.stringify(block.input), 2).forEach((piece, i) => {
        delta({ type: "input_json_delta", partial_json: piece });
        if (i === 0) at("start");
      });
    }
    event("content_block_stop", { type: "content_block_stop", index });
    at("end");
  });
  const usesTools = step.blocks.some((b) => b.kind === "tool");
  event("message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: usesTools ? "tool_use" : "end_turn",
      stop_sequence: null
    },
    usage: { output_tokens: 20 }
  });
  event("message_stop", { type: "message_stop" });
  items.push({ type: "checkpoint", id: `${prefix}.done` });
  return items;
}

/** A reply for requests the script does not cover. */
export function renderFallback(reason: string): StreamItem[] {
  const message = `(fake-model: ${reason})`;
  return [
    {
      type: "event",
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_fallback",
          type: "message",
          role: "assistant",
          model: "fake-model",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 }
        }
      }
    },
    {
      type: "event",
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }
    },
    {
      type: "event",
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: message }
      }
    },
    {
      type: "event",
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 0 }
    },
    {
      type: "event",
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 }
      }
    },
    { type: "event", event: "message_stop", data: { type: "message_stop" } }
  ];
}
