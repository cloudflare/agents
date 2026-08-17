import {
  Badge,
  Button,
  Empty,
  Input,
  PoweredByCloudflare,
  Surface,
  Text
} from "@cloudflare/kumo";
import {
  CheckIcon,
  InfoIcon,
  MoonIcon,
  PencilSimpleIcon,
  RobotIcon,
  SunIcon,
  TrashIcon,
  WarningCircleIcon
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  parseArgs,
  TODO_TEXT_MAX_LENGTH,
  todoTextSchema,
  type Todo,
  type TodoStatus
} from "./schemas";
import { useTodos, type TodoActions } from "./useTodos";
import { useWebMCPTools, type WebMCPToolsState } from "./useWebMCPTools";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function statusView(state: WebMCPToolsState) {
  if (state.error) {
    return {
      label: "WebMCP registration failed",
      detail: state.error.message,
      dot: "bg-red-500",
      text: "text-kumo-danger"
    };
  }
  if (state.registered) {
    return {
      label: "WebMCP tools ready",
      detail: "document.modelContext",
      dot: "bg-green-500",
      text: "text-kumo-success"
    };
  }
  if (state.supported) {
    return {
      label: "Registering WebMCP tools…",
      detail: "document.modelContext",
      dot: "bg-yellow-500",
      text: "text-kumo-warning"
    };
  }
  return {
    label: "WebMCP testing is not enabled",
    detail: "chrome://flags/#enable-webmcp-testing",
    dot: "bg-kumo-inactive",
    text: "text-kumo-subtle"
  };
}

function ModeToggle() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") || "light"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);

  return (
    <Button
      variant="ghost"
      shape="square"
      aria-label="Toggle theme"
      onClick={() => setMode((value) => (value === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

function TodoItem({ todo, actions }: { todo: Todo; actions: TodoActions }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(todo.text);
  const [error, setError] = useState<string | null>(null);

  function saveRename(event: FormEvent) {
    event.preventDefault();
    try {
      actions.renameTodo(todo.id, parseArgs(todoTextSchema, draft));
      setEditing(false);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <li className="grid min-h-14 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-kumo-line px-4 py-2 last:border-b-0">
      <label className="relative grid size-5 cursor-pointer place-items-center">
        <input
          type="checkbox"
          checked={todo.completed}
          onChange={(event) =>
            actions.setTodoCompleted(todo.id, event.target.checked)
          }
          className="peer size-4 appearance-none rounded border border-kumo-line bg-kumo-base checked:border-kumo-accent checked:bg-kumo-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-accent"
        />
        <CheckIcon
          size={11}
          weight="bold"
          aria-hidden="true"
          className="pointer-events-none absolute text-white opacity-0 peer-checked:opacity-100"
        />
        <span className="sr-only">
          Mark “{todo.text}” as {todo.completed ? "active" : "completed"}
        </span>
      </label>

      {editing ? (
        <form className="min-w-0 py-1" onSubmit={saveRename}>
          <label className="sr-only" htmlFor={`edit-${todo.id}`}>
            Rename todo
          </label>
          <Input
            id={`edit-${todo.id}`}
            value={draft}
            maxLength={TODO_TEXT_MAX_LENGTH}
            onChange={(event) => setDraft(event.target.value)}
            className="w-full"
          />
          <div className="mt-2 flex gap-2">
            <Button type="submit" variant="primary" size="sm">
              Save
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft(todo.text);
                setEditing(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
          {error && (
            <p className="mt-2 whitespace-pre-line text-xs text-kumo-danger">
              {error}
            </p>
          )}
        </form>
      ) : (
        <p
          className={`min-w-0 [overflow-wrap:anywhere] text-sm text-kumo-default ${
            todo.completed ? "text-kumo-inactive line-through" : ""
          }`}
        >
          {todo.text}
        </p>
      )}

      {!editing && (
        <div className="flex gap-1">
          <Button
            type="button"
            variant="ghost"
            shape="square"
            size="sm"
            onClick={() => {
              setDraft(todo.text);
              setEditing(true);
            }}
            aria-label={`Rename “${todo.text}”`}
            icon={<PencilSimpleIcon size={15} />}
          />
          <Button
            type="button"
            variant="ghost"
            shape="square"
            size="sm"
            className="text-kumo-danger"
            onClick={() => actions.deleteTodo(todo.id)}
            aria-label={`Delete “${todo.text}”`}
            icon={<TrashIcon size={15} />}
          />
        </div>
      )}
    </li>
  );
}

const filters: Array<{ value: TodoStatus; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "completed", label: "Completed" }
];

export default function App() {
  const { todos, actions } = useTodos();
  const webMCP = useWebMCPTools(actions);
  const [newTodo, setNewTodo] = useState("");
  const [filter, setFilter] = useState<TodoStatus>("all");
  const [error, setError] = useState<string | null>(null);

  const visibleTodos = useMemo(() => {
    if (filter === "active") return todos.filter((todo) => !todo.completed);
    if (filter === "completed") return todos.filter((todo) => todo.completed);
    return todos;
  }, [filter, todos]);

  const activeCount = todos.filter((todo) => !todo.completed).length;
  const completedCount = todos.length - activeCount;
  const status = statusView(webMCP);

  function submitTodo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitEvent = event.nativeEvent as SubmitEvent;
    try {
      const text = new FormData(event.currentTarget).get("text");
      const todo = actions.addTodo(
        parseArgs(todoTextSchema, typeof text === "string" ? text : "")
      );
      setNewTodo("");
      setError(null);

      // Declarative tool calls use this same form handler. respondWith sends
      // the completed action back to the agent without a page navigation.
      if (submitEvent.agentInvoked) {
        submitEvent.respondWith(
          Promise.resolve({
            message: "Todo added.",
            todo: {
              id: todo.id,
              text: todo.text,
              completed: todo.completed
            }
          })
        );
      }
    } catch (caught) {
      setError(errorMessage(caught));
      if (submitEvent.agentInvoked) {
        submitEvent.respondWith(Promise.reject(caught));
      }
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-kumo-elevated">
      <header className="border-b border-kumo-line bg-kumo-base px-5 py-4">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <RobotIcon size={22} weight="bold" className="text-kumo-accent" />
            <h1 className="text-lg font-semibold text-kumo-default">
              WebMCP React
            </h1>
            <Badge variant="secondary">experimental</Badge>
          </div>
          <output
            className="ml-auto flex items-center gap-2"
            title={status.detail}
            aria-live="polite"
          >
            <span className={`size-2 rounded-full ${status.dot}`} />
            <span className={`text-xs ${status.text}`}>{status.label}</span>
          </output>
          <ModeToggle />
        </div>
      </header>

      <main className="flex-1 px-5 py-6">
        <div className="mx-auto max-w-3xl space-y-5">
          <Surface className="rounded-xl p-4 ring ring-kumo-line">
            <div className="flex gap-3">
              <InfoIcon
                size={20}
                weight="bold"
                className="mt-0.5 shrink-0 text-kumo-accent"
              />
              <div>
                <Text size="sm" bold>
                  One set of actions for people and agents
                </Text>
                <span className="mt-1 block">
                  <Text size="xs" variant="secondary">
                    This todo app exposes four imperative browser tools and one
                    declarative HTML form tool. Actions invoked through WebMCP
                    update the same React state and visible interface as the
                    controls below.
                  </Text>
                </span>
              </div>
            </div>
          </Surface>

          {!webMCP.registered && (
            <Surface
              className={`rounded-xl p-4 ring ${
                webMCP.error ? "ring-red-500/30" : "ring-kumo-line"
              }`}
            >
              <div className="flex gap-3">
                <WarningCircleIcon
                  size={20}
                  weight="bold"
                  className={
                    webMCP.error
                      ? "mt-0.5 shrink-0 text-kumo-danger"
                      : "mt-0.5 shrink-0 text-kumo-warning"
                  }
                />
                <div>
                  <Text size="sm" bold>
                    {webMCP.error
                      ? "Tool registration failed"
                      : webMCP.supported
                        ? "Registering tools"
                        : "Enable WebMCP testing"}
                  </Text>
                  <p className="mt-1 text-xs text-kumo-subtle">
                    {webMCP.error ? (
                      webMCP.error.message
                    ) : webMCP.supported ? (
                      "Registering tools with document.modelContext…"
                    ) : (
                      <>
                        Enable{" "}
                        <code className="rounded bg-kumo-elevated px-1 py-0.5 font-mono text-kumo-default">
                          chrome://flags/#enable-webmcp-testing
                        </code>
                        , relaunch Chrome, then reload this page.
                      </>
                    )}
                  </p>
                </div>
              </div>
            </Surface>
          )}

          <Surface className="overflow-hidden rounded-xl ring ring-kumo-line">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-kumo-line px-4 py-3">
              <Text variant="heading3" as="h2">
                Todos
              </Text>
              <span className="text-xs tabular-nums text-kumo-subtle">
                {activeCount} active · {completedCount} completed
              </span>
            </div>

            <form
              className="flex flex-wrap gap-2 p-4"
              toolname="add_todo"
              tooldescription="Add one active todo to the current list."
              toolautosubmit=""
              onSubmit={submitTodo}
            >
              <label className="sr-only" htmlFor="new-todo">
                Add a todo
              </label>
              <Input
                id="new-todo"
                name="text"
                value={newTodo}
                required
                maxLength={TODO_TEXT_MAX_LENGTH}
                toolparamdescription="The todo text, between 1 and 200 characters."
                onChange={(event) => setNewTodo(event.target.value)}
                placeholder="What needs to be done?"
                className="min-w-52 flex-1"
              />
              <Button type="submit" variant="primary">
                Add todo
              </Button>
            </form>
            {error && (
              <p
                className="-mt-2 whitespace-pre-line px-4 pb-3 text-xs text-kumo-danger"
                role="alert"
              >
                {error}
              </p>
            )}

            <div
              className="flex gap-1 border-y border-kumo-line px-3 py-2"
              aria-label="Filter todos"
            >
              {filters.map(({ value, label }) => (
                <Button
                  key={value}
                  type="button"
                  variant={filter === value ? "secondary" : "ghost"}
                  size="sm"
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {label}
                </Button>
              ))}
            </div>

            {visibleTodos.length > 0 ? (
              <ul>
                {visibleTodos.map((todo) => (
                  <TodoItem key={todo.id} todo={todo} actions={actions} />
                ))}
              </ul>
            ) : (
              <div className="p-6">
                <Empty
                  icon={<CheckIcon size={28} />}
                  title={`No ${filter === "all" ? "" : `${filter} `}todos`}
                  description="Add one above or ask your agent."
                />
              </div>
            )}
          </Surface>
        </div>
      </main>

      <footer className="border-t border-kumo-line bg-kumo-base py-3">
        <div className="flex justify-center">
          <PoweredByCloudflare href="https://developers.cloudflare.com/workers/" />
        </div>
      </footer>
    </div>
  );
}
