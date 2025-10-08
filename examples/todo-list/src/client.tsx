import { useAgent } from "agents/react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { TodoState, Todo } from "./server";
import "./styles.css";

function App() {
  const [state, setState] = useState<TodoState>({
    todos: [],
    filter: "all"
  });
  const [inputValue, setInputValue] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  const agent = useAgent<TodoState>({
    agent: "todo-agent",
    onStateUpdate: (newState) => {
      setState(newState);
    }
  });

  const handleAddTodo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (inputValue.trim()) {
      await agent.call("addTodo", [inputValue.trim()]);
      setInputValue("");
    }
  };

  const handleToggleTodo = async (id: string) => {
    await agent.call("toggleTodo", [id]);
  };

  const handleDeleteTodo = async (id: string) => {
    await agent.call("deleteTodo", [id]);
  };

  const handleStartEdit = (todo: Todo) => {
    setEditingId(todo.id);
    setEditText(todo.text);
  };

  const handleSaveEdit = async (id: string) => {
    if (editText.trim()) {
      await agent.call("updateTodoText", [id, editText.trim()]);
    }
    setEditingId(null);
    setEditText("");
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditText("");
  };

  const handleClearCompleted = async () => {
    await agent.call("clearCompleted");
  };

  const handleSetFilter = async (filter: "all" | "active" | "completed") => {
    await agent.call("setFilter", [filter]);
  };

  const handleToggleAll = async () => {
    await agent.call("toggleAll");
  };

  const filteredTodos = state.todos.filter((todo) => {
    if (state.filter === "active") return !todo.completed;
    if (state.filter === "completed") return todo.completed;
    return true;
  });

  const activeCount = state.todos.filter((todo) => !todo.completed).length;
  const completedCount = state.todos.filter((todo) => todo.completed).length;
  const allCompleted = state.todos.length > 0 && activeCount === 0;

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

      {state.todos.length > 0 && (
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
            {filteredTodos.map((todo) => (
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
                    onChange={() => handleToggleTodo(todo.id)}
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

      {state.todos.length > 0 && (
        <footer className="footer">
          <span className="todo-count">
            <strong>{activeCount}</strong>{" "}
            {activeCount === 1 ? "item" : "items"} left
          </span>
          <ul className="filters">
            <li>
              <button
                type="button"
                className={state.filter === "all" ? "selected" : ""}
                onClick={() => handleSetFilter("all")}
              >
                All
              </button>
            </li>
            <li>
              <button
                type="button"
                className={state.filter === "active" ? "selected" : ""}
                onClick={() => handleSetFilter("active")}
              >
                Active
              </button>
            </li>
            <li>
              <button
                type="button"
                className={state.filter === "completed" ? "selected" : ""}
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
