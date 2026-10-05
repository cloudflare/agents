import {
  Editor,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  type OverlayHandle,
  type OverlayOptions,
  ProcessTerminal,
  TuiMainScreen
} from "@earendil-works/pi-tui";
import { type ClientEvent, WebChannelClient } from "../client";
import type { TuiArgs } from "./args";
import { type Context, TranscriptView } from "./components/blocks";
import { Header, PendingView, StatusBar } from "./components/footer";
import { ClientToolModal, ReasonModal } from "./components/modal";
import { sendHeadersOnUpgrade } from "./socket";
import { editorTheme } from "./theme";
import {
  type Block,
  initialUi,
  isCollapsible,
  type Local,
  moveSelection,
  needsYou,
  type Notice,
  type Pending,
  prompts,
  status,
  toggleAll,
  toggleBlock,
  toolPhase,
  transcriptBlocks
} from "./view";

type MutableLocal = {
  sent: Map<string, { messageId: string; text: string }>;
  outbox: Pending[];
  runningSince: Map<string, number>;
  notices: Notice[];
};

type ToolBlock = Extract<Block, { kind: "tool" }>;

const overlay: OverlayOptions = {
  anchor: "bottom-center",
  width: "100%",
  maxHeight: "80%"
};

/** `headers` gives the upgrade headers for each connection; default `args.headers`. */
export function runTui(
  args: TuiArgs,
  headers: () => Record<string, string> = () => args.headers
): Promise<void> {
  sendHeadersOnUpgrade(headers);
  const client = new WebChannelClient(args.url);
  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal);
  const context: Context = { frame: 0, ui: initialUi };

  const local: MutableLocal = {
    sent: new Map(),
    outbox: [],
    runningSince: new Map(),
    notices: []
  };
  let seen = false;
  let closing = false;
  let blocks: Block[] = [];
  let modal: { handle: OverlayHandle; key: string; name: string } | undefined;
  /** Prompts already offered, so each opens or selects itself once. */
  const prompted = new Set<string>();

  const transcript = new TranscriptView(context);
  const pending = new PendingView();
  const editor = new Editor(tui, editorTheme, { paddingX: 1 });
  const conversation = conversationLabel(args.url);
  const statusBar = new StatusBar(conversation, context);
  const header = new Header(conversation);
  /** The conversation shown, to notice when the client follows another. */
  let following: string | undefined;
  tui.addChild(header);
  tui.addChild(transcript);
  tui.addChild(pending);
  tui.addChild(editor);
  tui.addChild(statusBar);
  tui.setFocus(editor);

  // Without a message to follow, a notice follows the last message shown
  // now, so later messages are not drawn above it.
  const notice = (text: string, tone: Notice["tone"], after?: string) => {
    const anchor = after ?? client.state.messages.at(-1)?.id;
    local.notices.push({
      key: `notice:${local.notices.length}`,
      text,
      tone,
      ...(anchor !== undefined && { after: anchor })
    });
  };

  const send = (event: ClientEvent, label: string, target?: string) => {
    const eventId = event.eventId ?? crypto.randomUUID();
    local.outbox.push({ eventId, label, ...(target && { target }) });
    const settle = () => {
      local.outbox = local.outbox.filter((p) => p.eventId !== eventId);
      refresh();
    };
    client.send({ ...event, eventId }).then(settle, (error: unknown) => {
      if (closing) return;
      notice(`✗ ${label} refused: ${errorText(error)}`, "error");
      settle();
    });
    refresh();
  };

  const hideModal = () => {
    modal?.handle.hide();
    modal = undefined;
  };

  const closeModal = () => {
    hideModal();
    refresh();
  };

  const answerClientTool = (block: ToolBlock) => {
    const { part, turnId } = block;
    if (turnId === undefined) return;
    const component = new ClientToolModal(
      tui,
      part,
      (result) => {
        hideModal();
        send(
          {
            type: "tool-result",
            turnId,
            toolCallId: part.toolCallId,
            result
          },
          `${result.ok ? "result" : "error"} for ${part.toolName}`,
          part.toolCallId
        );
      },
      closeModal
    );
    modal = {
      handle: tui.showOverlay(component, overlay),
      key: block.key,
      name: part.toolName
    };
  };

  const approve = (block: ToolBlock, approved: boolean, reason?: string) => {
    const { part, turnId } = block;
    if (turnId === undefined || !part.approval) return;
    context.ui = { ...context.ui, selected: undefined };
    send(
      {
        type: "approval-response",
        turnId,
        approvalId: part.approval.id,
        approved,
        ...(reason && { reason })
      },
      `${approved ? "approve" : "deny"} ${part.toolName}`,
      part.toolCallId
    );
  };

  const denyWithReason = (block: ToolBlock) => {
    const component = new ReasonModal(
      block.part,
      (reason) => {
        hideModal();
        approve(block, false, reason);
      },
      closeModal
    );
    modal = {
      handle: tui.showOverlay(component, overlay),
      key: block.key,
      name: block.part.toolName
    };
  };

  const refresh = () => {
    const state = client.state;
    const view: Local = local;
    const you = state.you?.id;
    context.you = you;
    blocks = transcriptBlocks(state, view);

    const { ui } = context;
    if (ui.selected && !blocks.some((b) => b.key === ui.selected)) {
      context.ui = { ...ui, selected: undefined };
    }
    if (modal) {
      const open = blocks.find((b) => b.key === modal?.key);
      if (open?.kind !== "tool" || (!open.sending && !needsYou(open, you))) {
        notice(`${modal.name} was answered elsewhere`, "info");
        hideModal();
      }
    }

    const waiting = prompts(blocks, you);
    const fresh = waiting.filter((b) => !prompted.has(b.key));
    for (const b of fresh) prompted.add(b.key);
    const next = fresh.at(-1);
    if (next && !modal && !context.ui.selected && editor.getText() === "") {
      if (toolPhase(next.part, next.turn) === "client") {
        answerClientTool(next);
      } else context.ui = { ...context.ui, selected: next.key };
    }

    transcript.update(blocks);
    const current = status(state, view, Date.now(), seen);
    pending.status = current;
    pending.prompts = waiting
      .filter((b) => b.key !== context.ui.selected)
      .map((b) => b.part.toolName);
    statusBar.status = current;
    statusBar.hint = selectionHint(blocks, context);
    tui.requestRender();
  };

  /** Keys for selected blocks and collapsing. True when consumed. */
  const blockKeys = (data: string): boolean => {
    const { ui } = context;
    const selected = blocks.find((b) => b.key === ui.selected);
    if (matchesKey(data, "ctrl+o") || matchesKey(data, "ctrl+t")) {
      const kind = matchesKey(data, "ctrl+o") ? "tool" : "reasoning";
      context.ui = toggleAll(ui, kind, blocks);
    } else if (selected) {
      const phase =
        selected.kind === "tool" && !selected.sending
          ? toolPhase(selected.part, selected.turn)
          : undefined;
      if (selected.kind === "tool" && phase === "approval") {
        const answer = matchesKey(data, "y")
          ? () => approve(selected, true)
          : matchesKey(data, "n")
            ? () => approve(selected, false)
            : matchesKey(data, "r")
              ? () => denyWithReason(selected)
              : undefined;
        if (answer) {
          answer();
          return true;
        }
      }
      if (
        selected.kind === "tool" &&
        phase === "client" &&
        needsYou(selected, context.you) &&
        matchesKey(data, "enter")
      ) {
        answerClientTool(selected);
      } else if (matchesKey(data, "up") || matchesKey(data, "down")) {
        const direction = matchesKey(data, "up") ? "up" : "down";
        context.ui = {
          ...ui,
          selected: moveSelection(blocks, ui.selected, direction)
        };
      } else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
        context.ui = toggleBlock(ui, selected.key);
      } else if (matchesKey(data, "escape")) {
        context.ui = { ...ui, selected: undefined };
      } else {
        context.ui = { ...ui, selected: undefined };
        refresh();
        return false;
      }
    } else if (matchesKey(data, "up") && editor.getText() === "") {
      const first = moveSelection(blocks, undefined, "up");
      if (first === undefined) return false;
      context.ui = { ...ui, selected: first };
    } else if (matchesKey(data, "escape")) {
      const running = client.state.turns.find((t) => t.status === "running");
      if (!running) return false;
      send(
        { type: "cancel", turnId: running.turnId },
        "cancel",
        running.turnId
      );
    } else {
      return false;
    }
    refresh();
    return true;
  };

  client.subscribe((state) => {
    if (state.connected) seen = true;
    if (state.conversationId !== following) {
      // A new conversation: what was shown for the old one no longer applies.
      if (following !== undefined) {
        local.sent.clear();
        local.runningSince.clear();
        local.notices = [];
        prompted.clear();
        context.ui = { ...context.ui, selected: undefined };
      }
      following = state.conversationId;
      const label = following ? `${conversation} · ${following}` : conversation;
      header.conversation = label;
      statusBar.conversation = label;
    }
    for (const turn of state.turns) {
      if (turn.status === "running" && !local.runningSince.has(turn.turnId)) {
        local.runningSince.set(turn.turnId, Date.now());
      }
    }
    refresh();
  });

  client.onActivity((activity) => {
    if (activity.type === "turn") {
      const { turn } = activity;
      if (turn.status !== "running") local.runningSince.delete(turn.turnId);
      if (turn.status === "settled" && turn.outcome === "failed") {
        notice(
          `✗ Turn failed${turn.error ? `: ${turn.error}` : ""}`,
          "error",
          turn.messageIds.at(-1)
        );
        refresh();
      } else if (turn.status === "settled" && turn.outcome === "aborted") {
        notice("⊘ Turn cancelled", "info", turn.messageIds.at(-1));
        refresh();
      }
    } else if (activity.type === "end" && activity.state === "interrupted") {
      notice("Response interrupted; waiting for the agent", "info");
      refresh();
    }
  });

  const listConversations = async () => {
    try {
      const conversations = await client.listConversations();
      const current = client.state.conversationId;
      if (conversations.length === 0) notice("No conversations yet", "info");
      for (const { id, parent, busy } of conversations) {
        const mark = id === current ? "● " : "  ";
        const forked = parent === undefined ? "" : ` ↳ forked from ${parent}`;
        notice(`${mark}${id}${forked}${busy ? " (busy)" : ""}`, "info");
      }
    } catch (error) {
      notice(`✗ /conversations failed: ${errorText(error)}`, "error");
    }
    refresh();
  };

  const switchTo = async (prefix: string | undefined) => {
    if (!prefix) {
      notice("Usage: /switch <conversation id>", "error");
      refresh();
      return;
    }
    let ids: string[];
    try {
      ids = (await client.listConversations()).map(({ id }) => id);
    } catch (error) {
      notice(`✗ /switch failed: ${errorText(error)}`, "error");
      refresh();
      return;
    }
    const matches = ids.includes(prefix)
      ? [prefix]
      : ids.filter((id) => id.startsWith(prefix));
    if (matches.length !== 1) {
      notice(
        matches.length === 0
          ? `No conversation matches ${prefix}`
          : `${prefix} matches ${matches.length} conversations`,
        "error"
      );
      refresh();
      return;
    }
    client.follow(matches[0]);
  };

  /** A conversation command, such as `/fork`. True when handled. */
  const command = (text: string): boolean => {
    const [name, ...rest] = text.trim().split(/\s+/);
    if (name === "/conversations") {
      void listConversations();
      return true;
    }
    if (name === "/switch") {
      void switchTo(rest[0]);
      return true;
    }
    const event: ClientEvent | undefined =
      name === "/new"
        ? { type: "conversation-create" }
        : name === "/fork"
          ? { type: "conversation-fork" }
          : name === "/reset"
            ? {
                type: "conversation-reset",
                ...(rest.length && { handoff: rest.join(" ") })
              }
            : undefined;
    if (!event) return false;
    if (!client.state.operations.includes(event.type)) {
      notice(`${name} is not supported by this agent`, "error");
      refresh();
      return true;
    }
    send(event, name);
    return true;
  };

  editor.onSubmit = (text) => {
    if (!text) return;
    if (command(text)) return;
    const eventId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    local.sent.set(eventId, { messageId, text });
    send(
      {
        type: "message",
        eventId,
        message: {
          id: messageId,
          role: "user",
          parts: [{ type: "text", text }]
        }
      },
      text
    );
  };

  return new Promise((resolve) => {
    const quit = () => {
      closing = true;
      clearInterval(ticker);
      tui.stop();
      client.close();
      resolve();
    };
    tui.addInputListener((data) => {
      // Listeners see the Kitty protocol's release and repeat events, which
      // the focused component never does. Only arrows act on a held key.
      if (isKeyRelease(data)) return undefined;
      if (
        isKeyRepeat(data) &&
        !matchesKey(data, "up") &&
        !matchesKey(data, "down")
      ) {
        return undefined;
      }
      if (
        matchesKey(data, "ctrl+c") ||
        (matchesKey(data, "ctrl+d") && !modal && editor.getText() === "")
      ) {
        quit();
        return { consume: true };
      }
      if (modal) return undefined;
      return blockKeys(data) ? { consume: true } : undefined;
    });

    const ticker = setInterval(() => {
      context.frame++;
      const state = client.state;
      const busy =
        state.turns.some((t) => t.status === "running") ||
        local.outbox.length > 0;
      if (busy) refresh();
    }, 100);

    tui.start();
    refresh();
  });
}

function selectionHint(
  blocks: readonly Block[],
  context: Context
): string | undefined {
  const block = blocks.find((b) => b.key === context.ui.selected);
  if (!block || !isCollapsible(block)) return undefined;
  const keys = "↑↓ move · Space toggle · Esc back to composer";
  if (block.kind === "reasoning") return `reasoning · Enter toggle · ${keys}`;
  const name = block.part.toolName;
  if (block.sending) return `${name} · ${keys}`;
  const phase = toolPhase(block.part, block.turn);
  if (phase === "approval") {
    return `${name} · y approve · n deny · r deny with a reason · ${keys}`;
  }
  if (phase === "client" && needsYou(block, context.you)) {
    return `${name} · Enter answer · ${keys}`;
  }
  return `${name} · Enter toggle · ${keys}`;
}

function conversationLabel(url: string): string {
  const { host, pathname } = new URL(url);
  // The conversation id is shown on its own, and changes on follow.
  const route = /^(\/channels\/[^/]+)\/[^/]+$/.exec(pathname)?.[1];
  return `${host}${route ?? pathname}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
