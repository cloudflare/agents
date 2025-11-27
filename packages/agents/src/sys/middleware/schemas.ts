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

// ls(path?: string) — list directory contents
export const ListFilesSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: {
      type: "string",
      description:
        "Directory to list. Relative paths resolve to home. Use /shared for shared files, /agents/{id} for other agents. Default: home directory"
    }
  },
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
      description:
        "File path. Relative paths resolve to home. Use /shared/... for shared files, /agents/{id}/... for other agents"
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

// write_file(path: string, content: string)
export const WriteFileSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: {
      type: "string",
      description:
        "File path. Relative paths write to home. Use /shared/... for shared files. Cannot write to other agents' homes."
    },
    content: {
      type: "string",
      description: "File contents"
    }
  },
  required: ["path", "content"],
  title: "write_file"
} as const;

// edit_file(path: string, oldString: string, newString: string, replaceAll?: boolean)
export const EditFileSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: {
      type: "string",
      description:
        "File path. Relative paths edit in home. Use /shared/... for shared files. Cannot edit other agents' files."
    },
    oldString: {
      type: "string",
      description:
        "Exact string to match (must be unique unless replaceAll=true)"
    },
    newString: {
      type: "string",
      description: "Replacement string (can be empty)"
    },
    replaceAll: {
      type: "boolean",
      default: false,
      description: "Replace every occurrence instead of enforcing uniqueness"
    }
  },
  required: ["path", "oldString", "newString"],
  title: "edit_file"
} as const;

export const TaskSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    description: { type: "string" },
    subagentType: { type: "string" }
  },
  required: ["description", "subagentType"],
  title: "task"
} as const;
