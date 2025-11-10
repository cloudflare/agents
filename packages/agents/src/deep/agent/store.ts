// storage/store.ts
import type { ChatMessage, ToolCall, SubagentLink } from "../types";
import type { AgentEvent } from "../events";

function toJson(v: unknown) {
  return JSON.stringify(v ?? null);
}

function fromJson<T>(v: unknown): T | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      // if it's already a simple string value, just cast
      return v as unknown as T;
    }
  }
  return v as T;
}

export class Store {
  // In-memory cache
  private _messages?: ChatMessage[];
  private _events?: AgentEvent[];
  private _files?: Record<string, string>;
  private _waitingSubagents?: {
    token: string;
    childThreadId: string;
    toolCallId: string;
  }[];
  private _subagentLinks?: SubagentLink[];

  constructor(
    // Public so middlewares can access it
    public sql: SqlStorage
  ) {}

  /** Create tables if absent */
  init() {
    this.sql.exec(
      `
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','tool')),
  content TEXT,
  tool_call_id TEXT,
  tool_calls_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL,
  ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS waiting_subagents (
  token TEXT PRIMARY KEY,
  child_thread_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subagent_links (
  child_thread_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('waiting','completed','canceled')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  report TEXT,
  tool_call_id TEXT
);
`
    );
  }

  // --------------------------
  // Subagent links
  // --------------------------
  recordSubagentSpawn(link: {
    token: string;
    childThreadId: string;
    toolCallId: string;
  }): void {
    this.sql.exec(
      `INSERT INTO subagent_links (child_thread_id, token, status, created_at, tool_call_id)
       VALUES (?, ?, 'waiting', ?, ?)
       ON CONFLICT(child_thread_id) DO UPDATE SET
         token=excluded.token,
         status='waiting',
         created_at=excluded.created_at,
         completed_at=NULL,
         report=NULL,
         tool_call_id=excluded.tool_call_id`,
      link.childThreadId,
      link.token,
      Date.now(),
      link.toolCallId
    );
    this._subagentLinks = undefined;
  }

  markSubagentCompleted(childThreadId: string, report?: string): void {
    const completedAt = Date.now();
    this.sql.exec(
      `UPDATE subagent_links
       SET status='completed', completed_at=?, report=?
       WHERE child_thread_id = ?`,
      completedAt,
      report ?? null,
      childThreadId
    );
    this._subagentLinks = undefined;
  }

  markSubagentCanceled(childThreadId: string): void {
    this.sql.exec(
      `UPDATE subagent_links
       SET status='canceled', completed_at=?
       WHERE child_thread_id = ?`,
      Date.now(),
      childThreadId
    );
    this._subagentLinks = undefined;
  }

  listSubagentLinks(): SubagentLink[] {
    if (this._subagentLinks) return [...this._subagentLinks];
    const rows = this.sql.exec(
      `SELECT child_thread_id, token, status, created_at, completed_at, report, tool_call_id
       FROM subagent_links ORDER BY created_at ASC`
    );
    const links: SubagentLink[] = [];
    for (const r of rows ?? []) {
      const completedAtRaw = r.completed_at;
      const reportRaw = r.report;
      links.push({
        childThreadId: String(r.child_thread_id),
        token: String(r.token ?? ""),
        status: String(r.status) as SubagentLink["status"],
        createdAt: Number(r.created_at ?? Date.now()),
        completedAt:
          completedAtRaw === null || completedAtRaw === undefined
            ? undefined
            : Number(completedAtRaw),
        report:
          reportRaw === null || reportRaw === undefined
            ? undefined
            : String(reportRaw),
        toolCallId:
          r.tool_call_id === null || r.tool_call_id === undefined
            ? undefined
            : String(r.tool_call_id)
      });
    }
    this._subagentLinks = [...links];
    return [...links];
  }

  // --------------------------
  // Messages
  // --------------------------
  appendMessages(msgs: ChatMessage[]): void {
    if (!msgs.length) return;
    const t = Date.now();

    // Store in SQL first
    for (const m of msgs) {
      if (m.role === "assistant" && "toolCalls" in m && m.toolCalls) {
        this.sql.exec(
          `INSERT INTO messages (role, content, tool_call_id, tool_calls_json, created_at)
             VALUES ('assistant', NULL, NULL, ?, ?)`,
          toJson(m.toolCalls),
          t
        );
      } else if (m.role === "tool") {
        this.sql.exec(
          `INSERT INTO messages (role, content, tool_call_id, tool_calls_json, created_at)
             VALUES ('tool', ?, ?, NULL, ?)`,
          String(m.content ?? ""),
          String(m.toolCallId ?? ""),
          t
        );
      } else {
        // user or assistant with textual content
        const content =
          "content" in m ? String(m.content ?? "") : ("" as string);
        this.sql.exec(
          `INSERT INTO messages (role, content, tool_call_id, tool_calls_json, created_at)
             VALUES (?, ?, NULL, NULL, ?)`,
          m.role,
          content,
          t
        );
      }
    }

    // Invalidate cache to ensure consistency with DB
    // This forces a reload from SQL on next listMessages() call
    this._messages = undefined;
  }

  listMessages(): ChatMessage[] {
    if (this._messages) return [...this._messages];
    const rows = this.sql.exec(
      `SELECT role, content, tool_call_id, tool_calls_json
       FROM messages ORDER BY seq ASC`
    );
    const out: ChatMessage[] = [];
    for (const r of rows ?? []) {
      const role = String(r.role);
      if (role === "assistant" && r.tool_calls_json) {
        out.push({
          role: "assistant",
          toolCalls: fromJson<ToolCall[]>(r.tool_calls_json) ?? []
        });
      } else if (role === "tool") {
        out.push({
          role: "tool",
          content: String(r.content ?? ""),
          toolCallId: String(r.tool_call_id ?? "")
        });
      } else {
        out.push({
          role: role as "user" | "assistant",
          content: String(r.content ?? "")
        });
      }
    }
    this._messages = [...out];
    return out;
  }

  /** Insert one tool result message */
  appendToolResult(toolCallId: string, content: string): void {
    this.sql.exec(
      `INSERT INTO messages (role, content, tool_call_id, tool_calls_json, created_at)
       VALUES ('tool', ?, ?, NULL, ?)`,
      content,
      toolCallId,
      Date.now()
    );
    // Invalidate cache to ensure consistency with DB
    this._messages = undefined;
  }

  /** Get the last assistant message */
  lastAssistant(): ChatMessage | null {
    const rows = this.sql
      .exec(
        `SELECT role, content, tool_call_id, tool_calls_json
         FROM messages 
         WHERE role = 'assistant'
         ORDER BY seq DESC
         LIMIT 1`
      )
      .toArray();

    if (!rows || rows.length === 0) return null;

    const r = rows[0];
    if (r.tool_calls_json) {
      return {
        role: "assistant",
        toolCalls: fromJson<ToolCall[]>(r.tool_calls_json) ?? []
      };
    }

    return {
      role: "assistant",
      content: String(r.content ?? "")
    };
  }

  // --------------------------
  // Files
  // --------------------------
  mergeFiles(files: Record<string, string>): void {
    for (const [path, content] of Object.entries(files ?? {})) {
      this._files = { ...(this._files ?? {}), [path]: content };
      this.sql.exec(
        `INSERT INTO files (path, content, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at`,
        path,
        content,
        Date.now()
      );
    }
  }

  listFiles(): Record<string, string> {
    if (this._files) return { ...this._files };
    const rows = this.sql.exec(
      "SELECT path, content FROM files ORDER BY path ASC"
    );
    const out: Record<string, string> = {};
    for (const r of rows ?? []) {
      out[String(r.path)] =
        typeof r.content === "string"
          ? r.content
          : new TextDecoder().decode(r.content as ArrayBuffer);
    }
    this._files = { ...out };
    return out;
  }

  readFile(path: string): string | undefined {
    if (this._files?.[path]) return this._files[path];

    const rows = this.sql
      .exec("SELECT content FROM files WHERE path = ? LIMIT 1", [path])
      .toArray();
    if (!rows || rows.length === 0) return undefined;
    const v = rows[0].content;
    return typeof v === "string"
      ? v
      : new TextDecoder().decode(v as ArrayBuffer);
  }

  writeFile(path: string, content: string): void {
    this._files = { ...(this._files ?? {}), [path]: content };
    this.sql.exec(
      `INSERT INTO files (path, content, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at`,
      path,
      content,
      Date.now()
    );
  }

  /**
   * Utility edit that mirrors your tool’s semantics (string replacement).
   * Precondition checks (like "must have read before") should be enforced at the tool layer.
   */
  editFile(
    path: string,
    oldStr: string,
    newStr: string,
    replaceAll = false
  ): { replaced: number; content: string } {
    const current = this.readFile(path) ?? "";
    const count = (current.match(new RegExp(escapeRegExp(oldStr), "g")) || [])
      .length;
    if (count === 0) {
      return { replaced: 0, content: current };
    }
    if (!replaceAll && count > 1) {
      // leave unchanged; let caller decide
      return { replaced: -count, content: current }; // negative count means "ambiguous"
    }
    const content = replaceAll
      ? current.split(oldStr).join(newStr)
      : current.replace(oldStr, newStr);
    this.writeFile(path, content);
    return { replaced: replaceAll ? count : 1, content };
  }

  // --------------------------
  // Subagent waiters
  // --------------------------
  pushWaitingSubagent(w: {
    token: string;
    childThreadId: string;
    toolCallId: string;
  }): void {
    this.sql.exec(
      `INSERT INTO waiting_subagents (token, child_thread_id, tool_call_id, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(token) DO UPDATE SET child_thread_id=excluded.child_thread_id, tool_call_id=excluded.tool_call_id`,
      w.token,
      w.childThreadId,
      w.toolCallId,
      Date.now()
    );
    this.recordSubagentSpawn(w);
    // Invalidate cache to ensure consistency
    this._waitingSubagents = undefined;
  }

  popWaitingSubagent(
    token: string,
    childId: string
  ): {
    toolCallId: string;
  } | null {
    const rows = this.sql
      .exec(
        `SELECT token, child_thread_id, tool_call_id
         FROM waiting_subagents WHERE token = ? AND child_thread_id = ? LIMIT 1`,
        token,
        childId
      )
      .toArray();
    if (!rows || rows.length === 0) return null;
    this.sql.exec(
      "DELETE FROM waiting_subagents WHERE token = ? AND child_thread_id = ?",
      token,
      childId
    );
    // Invalidate cache to ensure consistency
    this._waitingSubagents = undefined;
    return { toolCallId: String(rows[0].tool_call_id) };
  }

  get waitingSubagents(): {
    token: string;
    childThreadId: string;
    toolCallId: string;
  }[] {
    if (this._waitingSubagents) return [...this._waitingSubagents];
    const rows = this.sql
      .exec(
        "SELECT token, child_thread_id, tool_call_id FROM waiting_subagents"
      )
      .toArray();
    this._waitingSubagents = rows.map((r) => ({
      token: String(r.token),
      childThreadId: String(r.child_thread_id),
      toolCallId: String(r.tool_call_id)
    }));
    return this._waitingSubagents;
  }

  // --------------------------
  // Events
  // --------------------------
  addEvent(e: AgentEvent): number {
    this.sql.exec(
      "INSERT INTO events (type, data_json, ts) VALUES (?, ?, ?)",
      e.type,
      toJson({ ...e.data }),
      e.ts
    );
    // Let's get the highest seq now
    const rows = this.sql
      .exec<{ seq: number }>("SELECT seq FROM events ORDER BY seq DESC LIMIT 1")
      .toArray();

    const seq = rows[0].seq;
    if (this._events) {
      this._events = [...this._events, { ...e, seq }];
    }

    return seq;
  }

  listEvents(): AgentEvent[] {
    if (this._events) return [...this._events];
    const rows = this.sql.exec(
      `SELECT seq, type, data_json, ts FROM events
       ORDER BY seq ASC`
    );
    const out: AgentEvent[] = [];
    for (const r of rows) {
      const data = fromJson(r.data_json) ?? {};
      out.push({
        threadId: "", // TODO: check what to do with this
        ts: String(r.ts),
        seq: Number(r.seq),
        type: String(r.type),
        data
      } as AgentEvent);
    }
    this._events = [...out];
    return out;
  }
}

// --------------------------
// Helpers
// --------------------------
function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
