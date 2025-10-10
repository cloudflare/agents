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
