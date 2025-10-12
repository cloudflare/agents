import type {
  AgentMiddleware,
  SubagentDescriptor,
  ToolCall,
  Todo,
  ToolHandler,
  ToolMeta
} from "../types";
import {
  WRITE_TODOS_SYSTEM_PROMPT,
  FILESYSTEM_SYSTEM_PROMPT,
  TASK_SYSTEM_PROMPT,
  TASK_TOOL_DESCRIPTION,
  WRITE_TODOS_TOOL_DESCRIPTION,
  WRITE_FILE_TOOL_DESCRIPTION,
  EDIT_FILE_TOOL_DESCRIPTION,
  LIST_FILES_TOOL_DESCRIPTION,
  READ_FILE_TOOL_DESCRIPTION
} from "./prompts";
import {
  WriteTodosSchema,
  ListFilesSchema,
  ReadFileSchema,
  WriteFileSchema,
  EditFileSchema,
  TaskSchema
} from "./schemas";
import { AgentEventType } from "../events";
import { getAgentByName } from "../../";
import type { AgentEnv } from "..";

/* -------------------- Planning: write_todos -------------------- */
const write_todos = defineTool(
  {
    name: "write_todos",
    description: WRITE_TODOS_TOOL_DESCRIPTION, // long, curated guidance
    parameters: WriteTodosSchema
  },
  async (p: { todos: Todo[] }, ctx) => {
    const sql = ctx.store.sql;
    const clean = (p.todos ?? []).map((t) => ({
      content: String(t.content ?? "").slice(0, 2000),
      status:
        t.status === "in_progress" || t.status === "completed"
          ? t.status
          : ("pending" as const)
    }));
    sql.exec("DELETE FROM todos");
    let pos = 0;
    for (const td of clean) {
      sql.exec(
        "INSERT INTO todos (content, status, pos, updated_at) VALUES (?, ?, ?, ?)",
        td.content,
        td.status,
        pos++,
        Date.now()
      );
    }
    return `Updated todo list (${clean.length} items).`;
  }
);

export function planning(): AgentMiddleware {
  return {
    name: "planning",
    tools: { write_todos },
    async onInit(ctx) {
      ctx.store.sql.exec(`
CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','in_progress','completed')),
  pos INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
`);
    },
    state: (ctx) => {
      const rows = ctx.store.sql.exec(
        "SELECT content, status FROM todos ORDER BY pos ASC, id ASC"
      );
      const todos: Todo[] = [];
      for (const r of rows) {
        todos.push({
          content: String(r.content ?? ""),
          status: String(r.status) as Todo["status"]
        });
      }
      return { todos };
    },
    async beforeModel(_, plan) {
      plan.addSystemPrompt(WRITE_TODOS_SYSTEM_PROMPT);
    }
  };
}

/* -------------------- Filesystem: ls/read/write/edit -------------------- */

export function filesystem(_opts?: { useR2: boolean }): AgentMiddleware {
  const ls = defineTool(
    {
      name: "ls",
      description: LIST_FILES_TOOL_DESCRIPTION,
      parameters: ListFilesSchema
    },
    async (_: {}, ctx) => Object.keys(ctx.store.listFiles())
  );

  const read_file = defineTool(
    {
      name: "read_file",
      description: READ_FILE_TOOL_DESCRIPTION,
      parameters: ReadFileSchema
    },
    async (p: { path: string; offset?: number; limit?: number }, ctx) => {
      const path = String(p.path ?? "");
      const raw = ctx.store.readFile(path);
      if (raw === undefined || raw === null)
        return `Error: File '${path}' not found`;

      ctx.store.setMeta(
        "lastReadPaths",
        Array.from(
          new Set([...(ctx.store.meta<string[]>("lastReadPaths") ?? []), path])
        )
      );
      if (raw.trim() === "")
        return "System reminder: File exists but has empty contents";

      const lines = raw.split(/\r?\n/);
      const offset = Math.max(0, Number(p.offset ?? 0));
      const limit = Math.max(1, Number(p.limit ?? 2000)); // number of lines, not tokens
      if (offset >= lines.length) {
        return `Error: Line offset ${offset} exceeds file length (${lines.length} lines)`;
      }
      const end = Math.min(lines.length, offset + limit);
      const out = [];
      for (let i = offset; i < end; i++) {
        let content = lines[i];
        if (content.length > 2000) content = content.slice(0, 2000);
        const lineNum = (i + 1).toString().padStart(6, " ");
        out.push(`${lineNum}\t${content}`);
      }

      return out.join("\n");
    }
  );

  const write_file = defineTool(
    {
      name: "write_file",
      description: WRITE_FILE_TOOL_DESCRIPTION,
      parameters: WriteFileSchema
    },
    async (p: { path: string; content: string }, ctx) => {
      const path = String(p.path ?? "");
      const content = String(p.content ?? "");
      ctx.store.writeFile(path, content);
      return `Updated file ${path}`;
    }
  );

  const edit_file = defineTool(
    {
      name: "edit_file",
      description: EDIT_FILE_TOOL_DESCRIPTION,
      parameters: EditFileSchema
    },
    async (
      p: {
        path: string;
        old_string: string;
        new_string: string;
        replace_all?: boolean;
      },
      ctx
    ) => {
      const path = String(p.path ?? "");
      const files = ctx.store.listFiles();
      if (!(path in files)) return `Error: File '${path}' not found`;

      // must read first at least once
      const readSet = new Set(ctx.store.meta<string[]>("lastReadPaths") ?? []);
      if (!readSet.has(path)) {
        return `Error: You must read '${path}' before editing it`;
      }

      const { replaced } = ctx.store.editFile(
        path,
        p.old_string,
        p.new_string,
        p.replace_all
      );

      if (replaced === 0)
        return `Error: String not found in file: '${p.old_string}'`;
      if (replaced < 0) {
        return `Error: String '${p.old_string}' appears ${Math.abs(replaced)} times. Use replace_all=true or provide a more specific old_string.`;
      }
      if (!p.replace_all && replaced > 1) {
        return `Error: String '${p.old_string}' appears ${replaced} times. Use replace_all=true or provide a more specific old_string.`;
      }

      return p.replace_all
        ? `Successfully replaced ${replaced} instance(s) in '${path}'`
        : `Successfully replaced string in '${path}'`;
    }
  );

  return {
    name: "filesystem",
    tools: { ls, read_file, write_file, edit_file },
    async beforeModel(_, plan) {
      plan.addSystemPrompt(FILESYSTEM_SYSTEM_PROMPT);
    },
    async onInit(ctx) {
      ctx.store.sql.exec(`CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        content BLOB,
        updated_at INTEGER NOT NULL
    )`);
    },
    state: (ctx) => {
      const rows = ctx.store.sql.exec(
        "SELECT path, content FROM files ORDER BY path ASC"
      );
      const files: Record<string, string> = {};
      for (const r of rows ?? []) {
        files[String(r.path)] =
          typeof r.content === "string"
            ? r.content
            : new TextDecoder().decode(r.content as ArrayBuffer);
      }
      return { files };
    }
  };
}

/* -------------------- Subagents: task -------------------- */

type TaskInput = {
  description: string;
  subagent_type: string;
  timeout_ms?: number;
};

function renderOtherAgents(subagents: SubagentDescriptor[]) {
  return subagents.length
    ? subagents.map((a) => `- ${a.name}: ${a.description}`).join("\n")
    : "- general-purpose: General-purpose agent for complex tasks (inherits main tools)";
}

export function subagents(
  opts: { subagents?: SubagentDescriptor[] } = {}
): AgentMiddleware {
  const otherAgents = renderOtherAgents(opts.subagents ?? []);
  const taskDesc = TASK_TOOL_DESCRIPTION.replace("{other_agents}", otherAgents);
  const task = defineTool(
    {
      name: "task",
      description: taskDesc,
      parameters: TaskSchema
    },
    async (p: TaskInput, ctx) => {
      const { description, subagent_type } = p;
      const token = crypto.randomUUID();
      const childId = crypto.randomUUID();

      // Fire SUBAGENT_SPAWNED event
      ctx.agent.emit(AgentEventType.SUBAGENT_SPAWNED, {
        child_thread_id: childId
      });

      // Get descriptor config
      const descriptor = ctx.agent.subagents.get(subagent_type);

      // Spawn child
      const subagent = await getAgentByName(
        (ctx.env as AgentEnv).DEEP_AGENT,
        childId
      );
      const res = await subagent.fetch(
        new Request("http://do/invoke", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            thread_id: childId,
            messages: [{ role: "user", content: String(description ?? "") }],
            meta: {
              parent: { thread_id: ctx.store.threadId, token },
              subagent_type: subagent_type,
              systemPrompt: descriptor?.prompt,
              model: descriptor?.model
            }
          })
        })
      );
      if (!res.ok) {
        // Spawn failed, return error immediately
        return "Error: Failed to spawn subagent";
      }

      // Register waiter ONLY after successful spawn
      const w = {
        token,
        child_thread_id: childId,
        tool_call_id: ctx.callId
      };
      ctx.store.pushWaitingSubagent(w);

      if (ctx.store.runState && ctx.store.runState.status === "running") {
        const rs = {
          ...ctx.store.runState,
          status: "paused" as const,
          reason: "subagent"
        };
        ctx.store.upsertRun(rs);
        ctx.agent.emit(AgentEventType.RUN_PAUSED, {
          run_id: ctx.store.runState.run_id,
          reason: "subagent"
        });
      }

      return null; // Won't immediately get added as a tool result
    }
  );

  return {
    name: "subagents",
    tools: { task },
    async beforeModel(_, plan) {
      plan.addSystemPrompt(TASK_SYSTEM_PROMPT);
    }
  };
}

export function hitl(opts: { interceptTools: string[] }): AgentMiddleware {
  return {
    name: "hitl",
    async onModelResult(ctx, res) {
      const last = res.message;
      const calls =
        last?.role === "assistant" && "tool_calls" in last
          ? (last.tool_calls ?? [])
          : [];
      const risky = calls.find((c: ToolCall) =>
        opts.interceptTools.includes(c.name)
      );
      if (risky) {
        ctx.store.upsertRun({
          ...ctx.store.runState!,
          status: "paused",
          reason: "hitl"
        });
        ctx.agent.emit(AgentEventType.RUN_PAUSED, {
          run_id: ctx.store.runState!.run_id,
          reason: "hitl"
        });
      }
    }
  };
}

export function defineTool(meta: ToolMeta, handler: ToolHandler): ToolHandler {
  handler.__tool = meta; // stash metadata on the function
  return handler;
}

export function getToolMeta(
  fn: ToolHandler,
  fallbackName?: string
): ToolMeta | null {
  const m = fn.__tool;
  return m ? m : fallbackName ? { name: fallbackName } : null;
}
