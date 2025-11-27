import type { AgentMiddleware, ToolCall, Todo, AgentBlueprint } from "../types";
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
  WriteTodosParams,
  ListFilesParams,
  ReadFileParams,
  WriteFileParams,
  EditFileParams,
  TaskParams
} from "./schemas";
import { AgentEventType } from "../events";
import { getAgentByName } from "../../";
import type { AgentEnv } from "..";
import { tool, type ToolContext } from "./tools";

export function defineMiddleware<TConfig>(
  mw: Omit<AgentMiddleware<TConfig>, "__configType">
): AgentMiddleware<TConfig> {
  return mw as AgentMiddleware<TConfig>;
}

/* -------------------- Planning: write_todos -------------------- */
const write_todos = tool({
  name: "write_todos",
  description: WRITE_TODOS_TOOL_DESCRIPTION,
  inputSchema: WriteTodosParams,
  execute: async (p, ctx) => {
    const sql = ctx.agent.store.sql;
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
});

export const planning: AgentMiddleware = {
  name: "planning",
  async onInit(ctx) {
    ctx.agent.store.sql.exec(`
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
    const rows = ctx.agent.store.sql.exec(
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
  async beforeModel(ctx, plan) {
    plan.addSystemPrompt(WRITE_TODOS_SYSTEM_PROMPT);
    ctx.registerTool(write_todos);
  },
  tags: ["planning"]
};

/* -------------------- Filesystem: ls/read/write/edit -------------------- */

/**
 * Filesystem middleware.
 *
 * Registers file tools that use the agent's built-in `fs` (AgentFileSystem).
 * The filesystem provides:
 * - Per-agent home directories: `/{agencyId}/agents/{agentId}/`
 * - Shared space: `/{agencyId}/shared/`
 * - Cross-agent read access (collaborative)
 *
 * Requires `FS: R2Bucket` binding in wrangler config.
 */
export const filesystem: AgentMiddleware = {
  name: "filesystem",

  async beforeModel(ctx, plan) {
    plan.addSystemPrompt(FILESYSTEM_SYSTEM_PROMPT);

    const agentFs = ctx.agent.fs;
    if (!agentFs) {
      console.warn(
        `R2 filesystem not available (missing FS binding or agent not registered). Filesystem tools disabled.`
      );
      return;
    }

    // Track read paths in KV for edit safety
    const getReadPaths = () =>
      new Set(ctx.agent.store.kv.get<string[]>("fsReadPaths") ?? []);
    const markRead = (path: string) => {
      const paths = getReadPaths();
      paths.add(path);
      ctx.agent.store.kv.put("fsReadPaths", Array.from(paths));
    };

    // ls - list directory
    const ls = tool({
      name: "ls",
      description: LIST_FILES_TOOL_DESCRIPTION,
      inputSchema: ListFilesParams,
      execute: async (p) => {
        try {
          const entries = await agentFs.readDir(p.path ?? ".");
          if (entries.length === 0) return "Directory is empty";
          return entries
            .map((e) => `${e.type === "dir" ? "d" : "-"} ${e.path}`)
            .join("\n");
        } catch (e) {
          return `Error: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
    });

    // read_file
    const read_file = tool({
      name: "read_file",
      description: READ_FILE_TOOL_DESCRIPTION,
      inputSchema: ReadFileParams,
      execute: async (p) => {
        const path = String(p.path ?? "");
        try {
          const raw = await agentFs.readFile(path, false);
          if (raw === null) return `Error: File '${path}' not found`;

          markRead(path);

          if (raw.trim() === "")
            return "System reminder: File exists but has empty contents";

          const lines = raw.split(/\r?\n/);
          const offset = Math.max(0, Number(p.offset ?? 0));
          const limit = Math.max(1, Number(p.limit ?? 2000));
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
        } catch (e) {
          return `Error: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
    });

    // write_file
    const write_file = tool({
      name: "write_file",
      description: WRITE_FILE_TOOL_DESCRIPTION,
      inputSchema: WriteFileParams,
      execute: async (p) => {
        const path = String(p.path ?? "");
        const content = String(p.content ?? "");
        try {
          await agentFs.writeFile(path, content);
          return `Updated file ${path}`;
        } catch (e) {
          return `Error: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
    });

    // edit_file
    const edit_file = tool({
      name: "edit_file",
      description: EDIT_FILE_TOOL_DESCRIPTION,
      inputSchema: EditFileParams,
      execute: async (p) => {
        const path = String(p.path ?? "");

        // Must read first
        const readPaths = getReadPaths();
        if (!readPaths.has(path)) {
          return `Error: You must read '${path}' before editing it`;
        }

        try {
          const { replaced } = await agentFs.editFile(
            path,
            p.oldString,
            p.newString,
            p.replaceAll
          );

          if (replaced === 0)
            return `Error: String not found in file: '${p.oldString}'`;
          if (replaced < 0) {
            return `Error: String '${p.oldString}' appears ${Math.abs(replaced)} times. Use replaceAll=true or provide a more specific oldString.`;
          }
          if (!p.replaceAll && replaced > 1) {
            return `Error: String '${p.oldString}' appears ${replaced} times. Use replaceAll=true or provide a more specific oldString.`;
          }

          return p.replaceAll
            ? `Successfully replaced ${replaced} instance(s) in '${path}'`
            : `Successfully replaced string in '${path}'`;
        } catch (e) {
          return `Error: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
    });

    ctx.registerTool(ls);
    ctx.registerTool(read_file);
    ctx.registerTool(write_file);
    ctx.registerTool(edit_file);
  },

  tags: ["fs"]
};

/* -------------------- Subagents: task -------------------- */
export type SubagentsConfig = {
  subagents?: {
    subagents: AgentBlueprint[];
  };
};

function renderOtherAgents(subagents: AgentBlueprint[]) {
  return subagents.length
    ? subagents.map((a) => `- ${a.name}: ${a.description}`).join("\n")
    : "- general-purpose: General-purpose agent for complex tasks (inherits main tools)";
}

export const subagents = defineMiddleware<SubagentsConfig>({
  name: "subagents",
  async beforeModel(ctx, plan) {
    plan.addSystemPrompt(TASK_SYSTEM_PROMPT);
    const config = ctx.agent.config as SubagentsConfig;
    const otherAgents = renderOtherAgents(config.subagents?.subagents ?? []);
    const taskDesc = TASK_TOOL_DESCRIPTION.replace(
      "{other_agents}",
      otherAgents
    );
    const task = tool({
      name: "task",
      description: taskDesc,
      inputSchema: TaskParams,
      execute: async (p, ctx) => {
        const { description, subagentType } = p;
        const token = crypto.randomUUID();
        const childId = crypto.randomUUID();

        // Fire SUBAGENT_SPAWNED event
        ctx.agent.emit(AgentEventType.SUBAGENT_SPAWNED, {
          childThreadId: childId
        });

        // Spawn child
        const subagent = await getAgentByName(
          (ctx.env as AgentEnv).SYSTEM_AGENT,
          childId
        );

        // This ensures the subagent knows what "type" it is (tools, prompt)
        // before it tries to run.
        const initRes = await subagent.fetch(
          new Request("http://do/register", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              id: childId,
              createdAt: new Date().toISOString(),
              agentType: subagentType, // Pass the requested type here
              request: ctx.agent.info.request, // Pass down request context (IP, etc)
              agencyId: ctx.agent.info.agencyId, // Required for blueprint lookup
              parent: {
                threadId: ctx.agent.info.threadId,
                token
              }
            })
          })
        );

        if (!initRes.ok) return "Error: Failed to initialize subagent";

        const res = await subagent.fetch(
          new Request("http://do/invoke", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              messages: [{ role: "user", content: String(description ?? "") }]
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
          childThreadId: childId,
          toolCallId: ctx.callId
        };
        ctx.agent.store.pushWaitingSubagent(w);

        const runState = ctx.agent.runState;
        if (runState && runState.status === "running") {
          runState.status = "paused";
          runState.reason = "subagent";
          ctx.agent.emit(AgentEventType.RUN_PAUSED, {
            runId: runState.runId,
            reason: "subagent"
          });
        }

        return null; // Won't immediately get added as a tool result
      }
    });
    ctx.registerTool(task);
  },
  tags: ["subagents"]
});

export type HitlConfig = {
  hitl?: {
    tools: string[];
  };
};

export const hitl = defineMiddleware<HitlConfig>({
  name: "hitl",
  async onModelResult(ctx, res) {
    const runState = ctx.agent.runState;
    const last = res.message;
    const calls =
      last?.role === "assistant" && "toolCalls" in last
        ? (last.toolCalls ?? [])
        : [];
    const config = ctx.agent.config as HitlConfig;
    const risky = calls.find((c: ToolCall) =>
      config.hitl?.tools.includes(c.name)
    );
    if (risky) {
      runState.status = "paused";
      runState.reason = "hitl";
      ctx.agent.emit(AgentEventType.RUN_PAUSED, {
        runId: runState.runId,
        reason: "hitl"
      });
    }
  },
  tags: ["hitl"]
});

// Re-export tool utilities
export {
  tool,
  getToolMeta,
  z,
  type ToolFn,
  type ToolResult,
  type ToolContext
} from "./tools";
