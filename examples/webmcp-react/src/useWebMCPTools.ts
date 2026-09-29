import { useEffect, useState } from "react";
import {
  deleteTodoArgsSchema,
  listTodosArgsSchema,
  parseArgs,
  renameTodoArgsSchema,
  setTodoCompletedArgsSchema,
  toolInputSchemas,
  type Todo
} from "./schemas";
import type { TodoActions } from "./useTodos";

const annotations = {
  readOnlyHint: false,
  untrustedContentHint: true
};

function presentTodo(todo: Todo) {
  return {
    id: todo.id,
    text: todo.text,
    completed: todo.completed
  };
}

export type WebMCPToolsState = {
  supported: boolean;
  registered: boolean;
  error: Error | null;
};

export function useWebMCPTools(actions: TodoActions): WebMCPToolsState {
  const { deleteTodo, getTodos, renameTodo, setTodoCompleted } = actions;
  const [state, setState] = useState<WebMCPToolsState>({
    supported: false,
    registered: false,
    error: null
  });

  useEffect(() => {
    const modelContext = document.modelContext;
    if (!modelContext) {
      setState({ supported: false, registered: false, error: null });
      return;
    }

    const registeredModelContext = modelContext;
    const controller = new AbortController();
    setState({ supported: true, registered: false, error: null });

    // The browser creates add_todo from the HTML form; these are the four
    // imperative tools that do not map naturally to one form submission.
    const tools: WebMCPTool[] = [
      {
        name: "list_todos",
        description:
          "List todos and their IDs, optionally filtered by active or completed status.",
        inputSchema: toolInputSchemas.listTodos,
        annotations: { ...annotations, readOnlyHint: true },
        async execute(args) {
          const { status = "all" } = parseArgs(listTodosArgsSchema, args);
          const todos = getTodos(status);
          return {
            status,
            count: todos.length,
            todos: todos.map(presentTodo)
          };
        }
      },
      {
        name: "rename_todo",
        description:
          "Replace the text of an existing todo identified by its ID.",
        inputSchema: toolInputSchemas.renameTodo,
        annotations,
        async execute(args) {
          const { id, text } = parseArgs(renameTodoArgsSchema, args);
          const todo = renameTodo(id, text);
          return { message: "Todo renamed.", todo: presentTodo(todo) };
        }
      },
      {
        name: "set_todo_completed",
        description:
          "Set an existing todo to completed or active, identified by its ID.",
        inputSchema: toolInputSchemas.setTodoCompleted,
        annotations,
        async execute(args) {
          const { id, completed } = parseArgs(setTodoCompletedArgsSchema, args);
          const todo = setTodoCompleted(id, completed);
          return {
            message: completed ? "Todo completed." : "Todo made active.",
            todo: presentTodo(todo)
          };
        }
      },
      {
        name: "delete_todo",
        description:
          "Permanently delete one existing todo identified by its ID.",
        inputSchema: toolInputSchemas.deleteTodo,
        annotations,
        async execute(args) {
          const { id } = parseArgs(deleteTodoArgsSchema, args);
          const todo = deleteTodo(id);
          return { message: "Todo deleted.", todo: presentTodo(todo) };
        }
      }
    ];

    async function registerTools() {
      try {
        await Promise.all(
          tools.map((tool) =>
            registeredModelContext.registerTool(tool, {
              signal: controller.signal
            })
          )
        );
        if (!controller.signal.aborted) {
          setState({ supported: true, registered: true, error: null });
        }
      } catch (caught) {
        if (!controller.signal.aborted) {
          setState({
            supported: true,
            registered: false,
            error:
              caught instanceof Error
                ? caught
                : new Error("WebMCP tool registration failed.")
          });
        }
      }
    }

    void registerTools();

    // Aborting unregisters every tool when the component unmounts.
    return () => controller.abort();
  }, [deleteTodo, getTodos, renameTodo, setTodoCompleted]);

  return state;
}
