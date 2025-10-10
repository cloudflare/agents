import type { AgentMiddleware, SubagentDescriptor, ToolCall } from "./types";
import type { Todo, ToolHandler, ToolMeta } from "./types";
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

/* -------------------- SCHEMAS -------------------- */
// write_todos(todos: Todo[])
export const WriteTodosSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    todos: {
      type: "array",
      // minItems not enforced — tool accepts any todo list update
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          content: { type: "string", description: "Task text" },
          status: {
            type: "string",
            enum: ["pending", "in_progress", "completed"],
            description: "Current task state"
          }
        },
        required: ["content", "status"]
      },
      description: "Full replacement list of todos"
    }
  },
  required: ["todos"],
  title: "write_todos"
} as const;

// ls() — no user parameters
export const ListFilesSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
  required: [],
  title: "ls"
} as const;

// read_file(path: string, offset?: number, limit?: number)
export const ReadFileSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: {
      type: "string",
      // Enforce absolute (Unix-style). If you need Windows too, expand the pattern.
      pattern: "^/",
      description: "Absolute path to the file"
    },
    offset: {
      type: "integer",
      minimum: 0,
      default: 0,
      description: "Line offset (0-based)"
    },
    limit: {
      type: "integer",
      minimum: 1,
      default: 2000,
      description: "Max number of lines to read"
    }
  },
  required: ["path"],
  title: "read_file"
} as const;

// write_file(_path: string, content: string)
export const WriteFileSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: {
      type: "string",
      pattern: "^/",
      description: "Absolute path to create/overwrite"
    },
    content: {
      type: "string",
      description: "File contents"
    }
  },
  required: ["path", "content"],
  title: "write_file"
} as const;

// edit_file(path: string, old_string: string, new_string: string, replace_all?: boolean)
export const EditFileSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: {
      type: "string",
      pattern: "^/",
      description: "Absolute path to edit"
    },
    old_string: {
      type: "string",
      description:
        "Exact string to match (must be unique unless replace_all=true)"
    },
    new_string: {
      type: "string",
      description: "Replacement string (can be empty)"
    },
    replace_all: {
      type: "boolean",
      default: false,
      description: "Replace every occurrence instead of enforcing uniqueness"
    }
  },
  required: ["path", "old_string", "new_string"],
  title: "edit_file"
} as const;

export const TaskSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    description: { type: "string" },
    subagent_type: { type: "string" }
  },
  required: ["description", "subagent_type"],
  title: "task"
} as const;

/* -------------------- Planning: write_todos -------------------- */
const write_todos = defineTool(
  {
    name: "write_todos",
    description: WRITE_TODOS_TOOL_DESCRIPTION, // long, curated guidance
    parameters: WriteTodosSchema
  },
  async (p: { todos: Todo[] }, ctx) => {
    const clean = (p.todos ?? []).map((t) => ({
      content: String(t.content ?? "").slice(0, 2000),
      status:
        t.status === "in_progress" || t.status === "completed"
          ? t.status
          : ("pending" as const)
    }));
    ctx.state.todos = clean;
    return `Updated todo list (${clean.length} items).`;
  }
);

export function planning(): AgentMiddleware {
  return {
    name: "planning",
    tools: { write_todos },
    async modifyModelRequest(req, _state) {
      return {
        ...req,
        systemPrompt: [req.systemPrompt, WRITE_TODOS_SYSTEM_PROMPT]
          .filter(Boolean)
          .join("\n\n")
      };
    }
  };
}

/* -------------------- Filesystem: ls/read/write/edit -------------------- */

export function filesystem(): AgentMiddleware {
  const ls = defineTool(
    {
      name: "ls",
      description: LIST_FILES_TOOL_DESCRIPTION,
      parameters: ListFilesSchema
    },
    async (_: {}, ctx) => Object.keys(ctx.state.files ?? {})
  );

  const read_file = defineTool(
    {
      name: "read_file",
      description: READ_FILE_TOOL_DESCRIPTION,
      parameters: ReadFileSchema
    },
    async (p: { path: string; offset?: number; limit?: number }, ctx) => {
      const path = String(p.path ?? "");
      const files = ctx.state.files ?? {};
      if (!(path in files)) return `Error: File '${path}' not found`;
      const raw = files[path] ?? "";

      if (!raw || raw.trim() === "") {
        // mark as read anyway
        ctx.state.meta = {
          ...(ctx.state.meta ?? {}),
          lastReadPaths: Array.from(
            new Set([...(ctx.state.meta?.lastReadPaths ?? []), path])
          )
        };
        return "System reminder: File exists but has empty contents";
      }

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

      // remember “read” for edit precondition
      ctx.state.meta = {
        ...(ctx.state.meta ?? {}),
        lastReadPaths: Array.from(
          new Set([...(ctx.state.meta?.lastReadPaths ?? []), path])
        )
      };

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
      ctx.state.files = { ...(ctx.state.files ?? {}), [path]: content };
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
      const files = ctx.state.files ?? {};
      if (!(path in files)) return `Error: File '${path}' not found`;

      // must read first at least once
      const readSet = new Set(ctx.state.meta?.lastReadPaths ?? []);
      if (!readSet.has(path)) {
        return `Error: You must read '${path}' before editing it`;
      }

      const oldStr = String(p.old_string ?? "");
      const newStr = String(p.new_string ?? "");
      const replaceAll = Boolean(p.replace_all);

      let content = files[path] ?? "";
      const count = (content.match(new RegExp(escapeRegExp(oldStr), "g")) || [])
        .length;

      if (count === 0) return `Error: String not found in file: '${oldStr}'`;
      if (!replaceAll && count > 1) {
        return `Error: String '${oldStr}' appears ${count} times. Use replace_all=true or provide a more specific old_string.`;
      }

      content = replaceAll
        ? content.split(oldStr).join(newStr)
        : content.replace(oldStr, newStr);

      ctx.state.files = { ...files, [path]: content };
      return replaceAll
        ? `Successfully replaced ${count} instance(s) in '${path}'`
        : `Successfully replaced string in '${path}'`;
    }
  );

  return {
    name: "filesystem",
    tools: { ls, read_file, write_file, edit_file },
    async modifyModelRequest(req) {
      return {
        ...req,
        systemPrompt: [req.systemPrompt, FILESYSTEM_SYSTEM_PROMPT]
          .filter(Boolean)
          .join("\n\n")
      };
    }
  };
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* -------------------- Subagents: task -------------------- */

type TaskInput = {
  description: string;
  subagent_type?: string;
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
    async (p: TaskInput, _ctx) => {
      return {
        __spawn: {
          description: p.description,
          subagent_type: p.subagent_type,
          timeout_ms: p.timeout_ms
        }
      };
    }
  );

  return {
    name: "subagents",
    tools: { task },
    async modifyModelRequest(req) {
      return {
        ...req,
        systemPrompt: [req.systemPrompt, TASK_SYSTEM_PROMPT]
          .filter(Boolean)
          .join("\n\n")
      };
    }
  };
}

export function hitl(opts: { interceptTools: string[] }): AgentMiddleware {
  return {
    name: "hitl",
    async afterModel(state) {
      const last = state.messages[state.messages.length - 1];
      const calls =
        last?.role === "assistant" && "tool_calls" in last
          ? (last.tool_calls ?? [])
          : [];
      const risky = calls.find((c: ToolCall) =>
        opts.interceptTools.includes(c.name)
      );
      if (risky) {
        // stash pending tool calls and pause
        return {
          meta: { ...state.meta, pendingToolCalls: calls },
          jumpTo: "end" as const
        };
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
