import { useCallback, useRef, useState } from "react";
import { storedTodosSchema, type Todo, type TodoStatus } from "./schemas";

const STORAGE_KEY = "webmcp-starter.todos";

const starterTodos: Todo[] = [
  {
    id: "starter-learn",
    text: "Inspect the WebMCP tools",
    completed: false,
    createdAt: "2026-01-01T09:00:00.000Z"
  },
  {
    id: "starter-agent",
    text: "Ask an agent to add a todo",
    completed: false,
    createdAt: "2026-01-01T09:01:00.000Z"
  },
  {
    id: "starter-cloudflare",
    text: "Deploy the app to Cloudflare",
    completed: true,
    createdAt: "2026-01-01T09:02:00.000Z"
  }
];

function readStoredTodos(): Todo[] {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === null) {
    return starterTodos;
  }

  try {
    const result = storedTodosSchema.safeParse(JSON.parse(stored));
    return result.success ? result.data : starterTodos;
  } catch {
    return starterTodos;
  }
}

function requireTodo(todos: Todo[], id: string): Todo {
  const todo = todos.find((item) => item.id === id);
  if (!todo) {
    throw new Error(`Todo with ID "${id}" was not found.`);
  }
  return todo;
}

export type TodoActions = {
  getTodos: (status?: TodoStatus) => Todo[];
  addTodo: (text: string) => Todo;
  renameTodo: (id: string, text: string) => Todo;
  setTodoCompleted: (id: string, completed: boolean) => Todo;
  deleteTodo: (id: string) => Todo;
};

export function useTodos(): { todos: Todo[]; actions: TodoActions } {
  const [todos, setTodos] = useState<Todo[]>(readStoredTodos);

  // Tool calls can arrive before React renders the previous update. This ref
  // keeps every action synchronous and pointed at the latest committed list.
  const todosRef = useRef(todos);

  const commit = useCallback((next: Todo[]) => {
    todosRef.current = next;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setTodos(next);
  }, []);

  const getTodos = useCallback((status: TodoStatus = "all") => {
    if (status === "active") {
      return todosRef.current.filter((todo) => !todo.completed);
    }
    if (status === "completed") {
      return todosRef.current.filter((todo) => todo.completed);
    }
    return [...todosRef.current];
  }, []);

  // UI and WebMCP handlers validate external input before calling these shared
  // mutations, so each call follows one validation path.
  const addTodo = useCallback(
    (text: string) => {
      const todo: Todo = {
        id: crypto.randomUUID(),
        text,
        completed: false,
        createdAt: new Date().toISOString()
      };
      commit([...todosRef.current, todo]);
      return todo;
    },
    [commit]
  );

  const renameTodo = useCallback(
    (id: string, text: string) => {
      const current = requireTodo(todosRef.current, id);
      const renamed = { ...current, text };
      commit(todosRef.current.map((todo) => (todo.id === id ? renamed : todo)));
      return renamed;
    },
    [commit]
  );

  const setTodoCompleted = useCallback(
    (id: string, completed: boolean) => {
      const current = requireTodo(todosRef.current, id);
      const updated = { ...current, completed };
      commit(todosRef.current.map((todo) => (todo.id === id ? updated : todo)));
      return updated;
    },
    [commit]
  );

  const deleteTodo = useCallback(
    (id: string) => {
      const deleted = requireTodo(todosRef.current, id);
      commit(todosRef.current.filter((todo) => todo.id !== id));
      return deleted;
    },
    [commit]
  );

  return {
    todos,
    actions: {
      getTodos,
      addTodo,
      renameTodo,
      setTodoCompleted,
      deleteTodo
    }
  };
}

export { STORAGE_KEY };
