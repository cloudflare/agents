import WebSocket from "ws";
import { v7 as uuidv7 } from "uuid";
import {
  TUI, ProcessTerminal, Text, Markdown, Editor, Loader, Box, Spacer,
  CombinedAutocompleteProvider, matchesKey
} from "@mariozechner/pi-tui";
import { connectWs, sendConfig, sendChat } from "../protocol/connection.js";
import { MSG_CHAT_RESPONSE } from "../protocol/constants.js";
import { fg, mdTheme, editorTheme, userMsgBg, chalk } from "../ui/theme.js";
import { createToolBox, renderToolInput, renderToolOutput, renderToolPart } from "../ui/render.js";
import { getSlashCommands } from "../ui/commands.js";
import type { ThinkConfig } from "../local/config.js";
import { saveSession, touchSession, nameSession, findSession, listSessions } from "../local/sessions.js";

// Track tool call input as it streams
const toolInputBuffers = new Map<string, { name: string; text: string }>();

export async function runInteractive(config: ThinkConfig): Promise<void> {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  const c = config;

  let sessionId = c.session === "new" ? uuidv7() : c.session;
  let sessionName: string | undefined;

  function sessionLabel() {
    return sessionName ? `${chalk.bold(sessionName)} ${fg.dim(sessionId)}` : fg.dim(sessionId);
  }

  const header = new Text(
    fg.accent(chalk.bold("think")) + " — " + sessionLabel() + "\n" +
    fg.dim(`connecting — ${c.server} (${c.provider}/${c.model})`) + "\n"
  );
  tui.addChild(header);

  const autocomplete = new CombinedAutocompleteProvider(getSlashCommands(c.server), process.cwd());
  const editor = new Editor(tui, editorTheme);
  editor.setAutocompleteProvider(autocomplete);
  tui.addChild(editor);
  tui.setFocus(editor);

  function cleanExit() {
    ws?.close();
    tui.stop();
    // Restore terminal: show cursor, reset attributes, newline
    process.stdout.write("\x1b[?25h\x1b[0m\n");
    process.exit(0);
  }

  // Ctrl+C — raw mode swallows SIGINT
  const origHandleInput = editor.handleInput.bind(editor);
  editor.handleInput = (data: string) => {
    if (matchesKey(data, "ctrl+c")) {
      cleanExit();
    }
    if (matchesKey(data, "escape") && streaming) {
      ws.send(JSON.stringify({ type: "cf_agent_chat_request_cancel", id: reqId }));
      if (loader) { tui.removeChild(loader); loader = null; }
      streaming = false;
      reqId = null;
      respComp = null;
      respText = "";
      toolComp = null;
      editor.disableSubmit = false;
      tui.requestRender();
      return;
    }
    origHandleInput(data);
  };

  let ws: WebSocket;
  let connected = false;
  let streaming = false;
  let reqId: string | null = null;
  let respText = "";
  let respComp: Markdown | null = null;
  let toolComp: Box | null = null;
  let loader: Loader | null = null;

  function updateHeader(status: string, color: (t: string) => string) {
    tui.children[0] = new Text(
      fg.accent(chalk.bold("think")) + " — " + sessionLabel() + "\n" +
      color(status) + fg.dim(` — ${c.server} (${c.provider}/${c.model})`) + "\n"
    );
    tui.requestRender();
  }

  function addToChat(comp: unknown) {
    tui.children.splice(tui.children.length - 1, 0, comp as any);
  }

  function handleChunk(chunk: Record<string, unknown>) {
    const type = chunk.type as string;

    if (type === "text-delta") {
      const delta = (chunk.textDelta ?? chunk.delta) as string | undefined;
      if (!delta) return;
      if (loader) { tui.removeChild(loader); loader = null; }
      if (!respComp) {
        addToChat(new Spacer(1));
        respComp = new Markdown("", 1, 0, mdTheme);
        addToChat(respComp);
      }
      respText += delta;
      respComp.setText(respText);
      tui.requestRender();
      return;
    }

    if (type === "tool-input-start") {
      if (loader) { tui.removeChild(loader); loader = null; }
      respComp = null; respText = "";

      const name = chunk.toolName as string;
      const id = chunk.toolCallId as string;
      toolInputBuffers.set(id, { name, text: "" });
      toolComp = createToolBox(name);
      addToChat(new Spacer(1));
      addToChat(toolComp);
      tui.requestRender();
      return;
    }

    if (type === "tool-input-delta") {
      const id = chunk.toolCallId as string;
      const buf = toolInputBuffers.get(id);
      if (buf) buf.text += chunk.inputTextDelta as string;
      return;
    }

    if (type === "tool-input-available" && toolComp) {
      toolInputBuffers.delete(chunk.toolCallId as string);
      renderToolInput(toolComp, chunk.input as Record<string, unknown> | undefined);
      tui.requestRender();
      return;
    }

    if (type === "tool-output-available") {
      const output = chunk.output as Record<string, unknown> | undefined;
      if (!output || !toolComp) { toolComp = null; return; }
      renderToolOutput(toolComp, output);
      tui.requestRender();
      toolComp = null;
      return;
    }
  }

  // ── Connection ─────────────────────────────────────────────────
  function connect() {
    ws = connectWs(c.server, sessionId);

    let configSent = false;
    ws.on("message", (data) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.type === "cf_agent_identity" && !configSent) {
        configSent = true;
        connected = true;
        sendConfig(ws, c);
        // Request message history
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "cf_think_get_messages" }));
        }
        updateHeader("connected", fg.success);
        saveSession({
          id: sessionId,
          server: c.server,
          model: `${c.provider}/${c.model}`,
          createdAt: new Date().toISOString()
        });
      }

      // Render history on connect (Think sends full message list)
      if (msg.type === "cf_agent_chat_messages") {
        const messages = msg.messages as Array<{ role: string; parts?: Array<Record<string, unknown>> }> | undefined;
        if (messages && messages.length > 0) {
          // Clear chat area (keep header + editor)
          tui.children.splice(1, tui.children.length - 2);
          for (const m of messages) {
            if (!m.parts || m.parts.length === 0) continue;

            if (m.role === "user") {
              const text = m.parts
                .filter((p) => p.type === "text" && p.text)
                .map((p) => p.text as string)
                .join("\n");
              if (!text) continue;
              addToChat(new Spacer(1));
              addToChat(new Markdown(text, 1, 1, mdTheme, { bgColor: userMsgBg }));
              continue;
            }

            // Assistant message — render text and tool calls in order
            for (const p of m.parts) {
              if (p.type === "text" && p.text) {
                addToChat(new Spacer(1));
                addToChat(new Markdown(p.text as string, 1, 0, mdTheme));
              }

              if (typeof p.type === "string" && p.type.startsWith("tool-") && p.toolName) {
                const [spacer, box] = renderToolPart(p);
                addToChat(spacer);
                addToChat(box);
              }
            }
          }
          addToChat(new Spacer(2));
          tui.requestRender();
        }
      }

      if (msg.type !== MSG_CHAT_RESPONSE) return;
      const resp = msg as { id: string; body: string; done: boolean };
      if (resp.id !== reqId) return;

      if (resp.done) {
        if (loader) { tui.removeChild(loader); loader = null; }
        if ((resp as Record<string, unknown>).error) {
          addToChat(new Text(fg.error("Error: " + (resp as Record<string, unknown>).error), 1, 0));
        }
        addToChat(new Spacer(2));
        streaming = false;
        reqId = null;
        respComp = null;
        respText = "";
        toolComp = null;
        editor.disableSubmit = false;
        tui.requestRender();
        return;
      }

      if (resp.body) {
        try {
          handleChunk(JSON.parse(resp.body));
        } catch {
          if (loader) { tui.removeChild(loader); loader = null; }
          addToChat(new Text(fg.error(resp.body), 1, 0));
          addToChat(new Spacer(1));
          streaming = false;
          reqId = null;
          respComp = null;
          respText = "";
          toolComp = null;
          editor.disableSubmit = false;
          tui.requestRender();
        }
      }
    });

    ws.on("close", () => {
      connected = false;
      updateHeader("disconnected", fg.error);
      setTimeout(connect, 2000);
    });

    ws.on("error", () => {});
  }

  // ── Input ──────────────────────────────────────────────────────
  editor.onSubmit = (value: string) => {
    const t = value.trim();
    if (!t || streaming || !connected) return;

    if (t === "/exit" || t === "/quit") {
      cleanExit();
      return;
    }
    if (t === "/clear") {
      ws?.send(JSON.stringify({ type: "cf_agent_chat_clear" }));
      tui.children.splice(1, tui.children.length - 2);
      tui.requestRender();
      return;
    }
    if (t === "/session") {
      addToChat(new Spacer(1));
      const nameInfo = sessionName ? `\nName: ${sessionName}` : "";
      addToChat(new Text(fg.accent(`Session: ${sessionId}${nameInfo}\nServer: ${c.server}\nModel: ${c.provider}/${c.model}`), 1, 0));
      tui.requestRender();
      return;
    }
    if (t === "/new") {
      sessionId = uuidv7();
      sessionName = undefined;
      ws?.close();
      tui.children.splice(1, tui.children.length - 2);
      updateHeader("new session", fg.accent);
      connect();
      return;
    }
    if (t === "/name" || t.startsWith("/name ")) {
      const name = t.slice(5).trim();
      if (!name) {
        addToChat(new Text(fg.dim("Usage: /name <alias>"), 1, 0));
      } else {
        nameSession(sessionId, name);
        sessionName = name;
        updateHeader("connected", fg.success);
        addToChat(new Spacer(1));
        addToChat(new Text(fg.success(`Session named: ${chalk.bold(name)}`), 1, 0));
      }
      tui.requestRender();
      return;
    }
    if (t === "/resume" || t.startsWith("/resume ")) {
      const query = t.slice(7).trim();
      if (query) {
        const found = findSession(query, c.server);
        if (!found) {
          addToChat(new Text(fg.error(`No session matching "${query}"`), 1, 0));
          tui.requestRender();
          return;
        }
        sessionId = found.id;
        sessionName = found.name;
        ws?.close();
        tui.children.splice(1, tui.children.length - 2);
        updateHeader("resuming...", fg.accent);
        connect();
      } else {
        // List sessions
        const sessions = listSessions(c.server);
        if (sessions.length === 0) {
          addToChat(new Text(fg.dim("No previous sessions found."), 1, 0));
        } else {
          addToChat(new Spacer(1));
          const lines = sessions.slice(0, 20).map((s) => {
            const label = s.name ? chalk.bold(s.name) + " " + fg.dim(s.id) : fg.accent(s.id);
            const preview = s.firstMessage ? fg.dim(s.firstMessage.slice(0, 40)) : fg.dim("(empty)");
            const date = fg.dim(new Date(s.lastUsedAt).toLocaleDateString());
            const active = s.id === sessionId ? fg.success(" ●") : "";
            return `  ${label} ${preview} ${date}${active}`;
          });
          addToChat(new Text(
            fg.accent("Sessions") + fg.dim(` (${sessions.length} total)\n`) +
            lines.join("\n") + "\n\n" +
            fg.dim("Usage: /resume <name or id>"),
            1, 0
          ));
        }
        tui.requestRender();
      }
      return;
    }
    if (t === "/model") {
      addToChat(new Spacer(1));
      addToChat(new Text(fg.accent(`${c.provider}/${c.model}`), 1, 0));
      tui.requestRender();
      return;
    }

    streaming = true;
    editor.disableSubmit = true;

    addToChat(new Spacer(1));
    addToChat(new Markdown(t, 1, 1, mdTheme, { bgColor: userMsgBg }));

    loader = new Loader(tui, fg.accent, fg.dim, "Thinking...");
    addToChat(loader);
    tui.requestRender();

    reqId = crypto.randomUUID();
    respText = "";
    respComp = null;
    toolComp = null;
    sendChat(ws, reqId, t);
    // Update session index with first message + touch timestamp
    touchSession(sessionId);
    saveSession({
      id: sessionId,
      server: c.server,
      model: `${c.provider}/${c.model}`,
      firstMessage: t.slice(0, 100),
      createdAt: new Date().toISOString()
    });
  };

  process.on("SIGINT", cleanExit);

  connect();
  tui.start();
}
