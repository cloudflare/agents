import { tool } from "ai";
import { z } from "zod";

/** Create the SQLite tables (idempotent). */
export function initDatabase(sql: SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  sql.exec(`CREATE TABLE IF NOT EXISTS sprints (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    start_date TEXT,
    end_date TEXT,
    status TEXT DEFAULT 'planned',
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  sql.exec(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'todo',
    priority TEXT DEFAULT 'medium',
    assignee TEXT DEFAULT '',
    sprint_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  sql.exec(`CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    author TEXT DEFAULT 'user',
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
}

/** Build the PM tools wired to the given SqlStorage using AI SDK tool(). */
export function createTools(sql: SqlStorage) {
  return {
    createProject: tool({
      description: "Create a new project",
      inputSchema: z.object({
        name: z.string().describe("Project name"),
        description: z.string().optional().describe("Project description")
      }),
      execute: async ({ name, description }) => {
        const id = crypto.randomUUID();
        sql.exec(
          "INSERT INTO projects (id, name, description) VALUES (?, ?, ?)",
          id,
          name,
          description ?? ""
        );
        return { id, name, description: description ?? "" };
      }
    }),

    listProjects: tool({
      description: "List all projects",
      inputSchema: z.object({}),
      execute: async () => {
        return sql
          .exec("SELECT * FROM projects ORDER BY created_at DESC")
          .toArray();
      }
    }),

    createTask: tool({
      description: "Create a task in a project",
      inputSchema: z.object({
        projectId: z.string().describe("Project ID"),
        title: z.string().describe("Task title"),
        description: z.string().optional().describe("Task description"),
        status: z
          .enum(["todo", "in_progress", "in_review", "done"])
          .optional()
          .describe("Task status"),
        priority: z
          .enum(["low", "medium", "high", "urgent"])
          .optional()
          .describe("Priority level"),
        assignee: z.string().optional().describe("Assignee name"),
        sprintId: z.string().optional().describe("Sprint ID")
      }),
      execute: async ({
        projectId,
        title,
        description,
        status,
        priority,
        assignee,
        sprintId
      }) => {
        const id = crypto.randomUUID();
        sql.exec(
          `INSERT INTO tasks (id, project_id, title, description, status, priority, assignee, sprint_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          projectId,
          title,
          description ?? "",
          status ?? "todo",
          priority ?? "medium",
          assignee ?? "",
          sprintId ?? null
        );
        return {
          id,
          projectId,
          title,
          status: status ?? "todo",
          priority: priority ?? "medium"
        };
      }
    }),

    listTasks: tool({
      description: "List tasks with optional filters",
      inputSchema: z.object({
        projectId: z.string().optional().describe("Filter by project ID"),
        status: z.string().optional().describe("Filter by status"),
        priority: z.string().optional().describe("Filter by priority"),
        assignee: z.string().optional().describe("Filter by assignee"),
        sprintId: z.string().optional().describe("Filter by sprint ID")
      }),
      execute: async ({ projectId, status, priority, assignee, sprintId }) => {
        let query = "SELECT * FROM tasks WHERE 1=1";
        const params: unknown[] = [];
        if (projectId) {
          query += " AND project_id = ?";
          params.push(projectId);
        }
        if (status) {
          query += " AND status = ?";
          params.push(status);
        }
        if (priority) {
          query += " AND priority = ?";
          params.push(priority);
        }
        if (assignee) {
          query += " AND assignee = ?";
          params.push(assignee);
        }
        if (sprintId) {
          query += " AND sprint_id = ?";
          params.push(sprintId);
        }
        query += " ORDER BY created_at DESC";
        return sql.exec(query, ...params).toArray();
      }
    }),

    updateTask: tool({
      description: "Update a task's fields",
      inputSchema: z.object({
        id: z.string().describe("Task ID"),
        title: z.string().optional().describe("New title"),
        description: z.string().optional().describe("New description"),
        status: z
          .enum(["todo", "in_progress", "in_review", "done"])
          .optional()
          .describe("New status"),
        priority: z
          .enum(["low", "medium", "high", "urgent"])
          .optional()
          .describe("New priority"),
        assignee: z.string().optional().describe("New assignee"),
        sprintId: z.string().optional().describe("New sprint ID")
      }),
      execute: async ({ id, ...fields }) => {
        const fieldToColumn: Record<string, string> = {
          title: "title",
          description: "description",
          status: "status",
          priority: "priority",
          assignee: "assignee",
          sprintId: "sprint_id"
        };

        const sets: string[] = [];
        const params: unknown[] = [];
        for (const [key, value] of Object.entries(fields)) {
          const col = fieldToColumn[key];
          if (col && value !== undefined) {
            sets.push(`${col} = ?`);
            params.push(value);
          }
        }
        if (sets.length === 0) return { error: "No fields to update" };
        sets.push("updated_at = datetime('now')");
        params.push(id);
        sql.exec(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, ...params);
        return (
          sql.exec("SELECT * FROM tasks WHERE id = ?", id).toArray()[0] ?? {
            error: "Task not found"
          }
        );
      }
    }),

    deleteTask: tool({
      description: "Delete a task and its comments",
      inputSchema: z.object({
        id: z.string().describe("Task ID to delete")
      }),
      execute: async ({ id }) => {
        sql.exec("DELETE FROM comments WHERE task_id = ?", id);
        sql.exec("DELETE FROM tasks WHERE id = ?", id);
        return { deleted: id };
      }
    }),

    createSprint: tool({
      description: "Create a sprint for a project",
      inputSchema: z.object({
        projectId: z.string().describe("Project ID"),
        name: z.string().describe("Sprint name"),
        startDate: z.string().optional().describe("Start date (ISO 8601)"),
        endDate: z.string().optional().describe("End date (ISO 8601)")
      }),
      execute: async ({ projectId, name, startDate, endDate }) => {
        const id = crypto.randomUUID();
        sql.exec(
          "INSERT INTO sprints (id, project_id, name, start_date, end_date) VALUES (?, ?, ?, ?, ?)",
          id,
          projectId,
          name,
          startDate ?? null,
          endDate ?? null
        );
        return { id, projectId, name, startDate, endDate, status: "planned" };
      }
    }),

    listSprints: tool({
      description: "List sprints, optionally by project",
      inputSchema: z.object({
        projectId: z.string().optional().describe("Filter by project ID")
      }),
      execute: async ({ projectId }) => {
        if (projectId) {
          return sql
            .exec(
              "SELECT * FROM sprints WHERE project_id = ? ORDER BY created_at DESC",
              projectId
            )
            .toArray();
        }
        return sql
          .exec("SELECT * FROM sprints ORDER BY created_at DESC")
          .toArray();
      }
    }),

    addComment: tool({
      description: "Add a comment to a task",
      inputSchema: z.object({
        taskId: z.string().describe("Task ID"),
        content: z.string().describe("Comment content"),
        author: z.string().optional().describe("Author name")
      }),
      execute: async ({ taskId, content, author }) => {
        const id = crypto.randomUUID();
        sql.exec(
          "INSERT INTO comments (id, task_id, author, content) VALUES (?, ?, ?, ?)",
          id,
          taskId,
          author ?? "user",
          content
        );
        return { id, taskId, author: author ?? "user", content };
      }
    }),

    listComments: tool({
      description: "List comments on a task",
      inputSchema: z.object({
        taskId: z.string().describe("Task ID")
      }),
      execute: async ({ taskId }) => {
        return sql
          .exec(
            "SELECT * FROM comments WHERE task_id = ? ORDER BY created_at ASC",
            taskId
          )
          .toArray();
      }
    })
  };
}
