import { useAgent } from "agents/react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Todo } from "./server";
import {
  useDurableQuery,
  useDurableMutation
} from "agents/durable-query-react";
import "./styles.css";

function App() {
  const [filter, setFilter] = useState<"all" | "active" | "completed">("all");
  const [inputValue, setInputValue] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  const agent = useAgent({
    agent: "todo-agent"
  });

  const completedFilter = filter === "all" ? undefined : filter === "completed";
  const { data: todos = [], isLoading } = useDurableQuery<
    { completed?: boolean },
    Todo
  >(agent, "getTodos", { completed: completedFilter });

  const { mutate: addTodo } = useDurableMutation<
    { text: string },
    { id: string }
  >(agent, "addTodo");

  const { mutate: toggleTodo } = useDurableMutation<
    { id: string; completed: boolean },
    void
  >(agent, "toggleTodo");

  const { mutate: deleteTodo } = useDurableMutation<{ id: string }, void>(
    agent,
    "deleteTodo"
  );

  const { mutate: updateTodoText } = useDurableMutation<
    { id: string; text: string },
    void
  >(agent, "updateTodoText");

  const { mutate: clearCompleted } = useDurableMutation<{}, void>(
    agent,
    "clearCompleted"
  );

  const { mutate: toggleAll } = useDurableMutation<{}, void>(
    agent,
    "toggleAll"
  );

  const handleAddTodo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (inputValue.trim()) {
      addTodo({ text: inputValue.trim() });
      setInputValue("");
    }
  };

  const handleToggleTodo = (id: string, completed: boolean) => {
    toggleTodo({ id, completed: !completed });
  };

  const handleDeleteTodo = (id: string) => {
    deleteTodo({ id });
  };

  const handleStartEdit = (todo: Todo) => {
    setEditingId(todo.id);
    setEditText(todo.text);
  };

  const handleSaveEdit = (id: string) => {
    if (editText.trim()) {
      updateTodoText({ id, text: editText.trim() });
    }
    setEditingId(null);
    setEditText("");
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditText("");
  };

  const handleClearCompleted = () => {
    clearCompleted({});
  };

  const handleSetFilter = (newFilter: "all" | "active" | "completed") => {
    setFilter(newFilter);
  };

  const handleToggleAll = () => {
    toggleAll({});
  };

  const activeCount = todos.filter((todo) => !todo.completed).length;
  const completedCount = todos.filter((todo) => todo.completed).length;
  const allCompleted = todos.length > 0 && activeCount === 0;

  if (isLoading) {
    return <div className="todo-app">Loading...</div>;
  }

  return (
    <div className="todo-app">
      <header className="header">
        <h1>todos</h1>
        <form onSubmit={handleAddTodo} className="todo-form">
          <input
            type="text"
            className="new-todo"
            placeholder="What needs to be done?"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            autoFocus
          />
        </form>
      </header>

      {todos.length > 0 && (
        <section className="main">
          <input
            id="toggle-all"
            className="toggle-all"
            type="checkbox"
            checked={allCompleted}
            onChange={handleToggleAll}
          />
          <label htmlFor="toggle-all">Mark all as complete</label>

          <ul className="todo-list">
            {todos.map((todo) => (
              <li
                key={todo.id}
                className={`${todo.completed ? "completed" : ""} ${
                  editingId === todo.id ? "editing" : ""
                }`}
              >
                <div className="view">
                  <input
                    className="toggle"
                    type="checkbox"
                    checked={todo.completed}
                    onChange={() => handleToggleTodo(todo.id, todo.completed)}
                  />
                  <label onDoubleClick={() => handleStartEdit(todo)}>
                    {todo.text}
                  </label>
                  <button
                    type="button"
                    className="destroy"
                    onClick={() => handleDeleteTodo(todo.id)}
                  />
                </div>
                {editingId === todo.id && (
                  <input
                    className="edit"
                    type="text"
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onBlur={() => handleSaveEdit(todo.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        handleSaveEdit(todo.id);
                      } else if (e.key === "Escape") {
                        handleCancelEdit();
                      }
                    }}
                    autoFocus
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {todos.length > 0 && (
        <footer className="footer">
          <span className="todo-count">
            <strong>{activeCount}</strong>{" "}
            {activeCount === 1 ? "item" : "items"} left
          </span>
          <ul className="filters">
            <li>
              <button
                type="button"
                className={filter === "all" ? "selected" : ""}
                onClick={() => handleSetFilter("all")}
              >
                All
              </button>
            </li>
            <li>
              <button
                type="button"
                className={filter === "active" ? "selected" : ""}
                onClick={() => handleSetFilter("active")}
              >
                Active
              </button>
            </li>
            <li>
              <button
                type="button"
                className={filter === "completed" ? "selected" : ""}
                onClick={() => handleSetFilter("completed")}
              >
                Completed
              </button>
            </li>
          </ul>
          {completedCount > 0 && (
            <button
              type="button"
              className="clear-completed"
              onClick={handleClearCompleted}
            >
              Clear completed
            </button>
          )}
        </footer>
      )}

      <footer className="info">
        <p>Double-click to edit a todo</p>
        <p>Open multiple windows to see state sync in real-time</p>
      </footer>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
