import { type AgentNamespace, routeAgentRequest, AgentContext } from "agents";
import { SyncAgent } from "../../../packages/agents/src/sync";

type Env = {
  TodoAgent: AgentNamespace<TodoAgent>;
};

export type Todo = {
  id: string;
  text: string;
  completed: boolean;
  createdAt: number;
};

export type TodoState = {
  todos: Todo[];
  filter?: string;
};

export class TodoAgent extends SyncAgent<Env, {}> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);

    this.sql`
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        completed INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `;

    this.registerQuery<{ completed?: boolean }, Todo>(
      "getTodos",
      (args) => {
        if (args.completed !== undefined) {
          return this.sql<Todo>`
            SELECT * FROM todos
            WHERE completed = ${args.completed ? 1 : 0}
            ORDER BY created_at DESC
          `;
        }
        return this.sql<Todo>`
          SELECT * FROM todos ORDER BY created_at DESC
        `;
      },
      { dependencies: ["todos"] }
    );

    this.registerQuery<{ id: string }, Todo>(
      "getTodo",
      (args) => {
        return this.sql<Todo>`
          SELECT * FROM todos WHERE id = ${args.id}
        `;
      },
      { dependencies: ["todos"] }
    );

    this.registerMutation<{ text: string }, { id: string }>(
      "addTodo",
      (args) => {
        const id = crypto.randomUUID();
        this.sql`
          INSERT INTO todos (id, text, completed, created_at)
          VALUES (${id}, ${args.text}, 0, ${Date.now()})
        `;
        return { id };
      },
      { invalidates: ["getTodos"] }
    );

    this.registerMutation<{ id: string; completed: boolean }, void>(
      "toggleTodo",
      (args) => {
        this.sql`
          UPDATE todos
          SET completed = ${args.completed ? 1 : 0}
          WHERE id = ${args.id}
        `;
      },
      { invalidates: ["getTodos", "getTodo"] }
    );

    this.registerMutation<{ id: string }, void>(
      "deleteTodo",
      (args) => {
        this.sql`DELETE FROM todos WHERE id = ${args.id}`;
      },
      { invalidates: ["getTodos"] }
    );

    this.registerMutation<{ id: string; text: string }, void>(
      "updateTodoText",
      (args) => {
        this.sql`
          UPDATE todos
          SET text = ${args.text}
          WHERE id = ${args.id}
        `;
      },
      { invalidates: ["getTodos", "getTodo"] }
    );

    this.registerMutation<{}, void>(
      "clearCompleted",
      () => {
        this.sql`DELETE FROM todos WHERE completed = 1`;
      },
      { invalidates: ["getTodos"] }
    );

    this.registerMutation<{}, void>(
      "toggleAll",
      () => {
        const todos = this.sql<{ completed: number }>`
          SELECT completed FROM todos
        `;
        const allCompleted = todos.every((todo) => todo.completed === 1);
        this.sql`
          UPDATE todos
          SET completed = ${allCompleted ? 0 : 1}
        `;
      },
      { invalidates: ["getTodos"] }
    );
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
