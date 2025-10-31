import React, { StrictMode, act } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { useAgent } from "agents/react";
import type { TodoState } from "./server";

vi.mock("agents/react", () => ({
  useAgent: vi.fn()
}));

describe("TodoApp React Integration", () => {
  let mockAgent: { call: typeof vi.fn };
  let onStateUpdateCallback: ((state: TodoState) => void) | undefined;

  beforeEach(() => {
    onStateUpdateCallback = undefined;

    mockAgent = {
      call: vi.fn()
    };

    vi.mocked(useAgent).mockImplementation((options) => {
      onStateUpdateCallback = options.onStateUpdate;
      return mockAgent;
    });
  });

  it("initializes with empty state and renders correctly", async () => {
    const TestComponent = () => {
      const [state, setState] = React.useState<TodoState>({
        todos: [],
        filter: "all"
      });

      useAgent<TodoState>({
        agent: "todo-agent",
        onStateUpdate: (newState) => {
          setState(newState);
        }
      });

      return (
        <div>
          <h1 data-testid="title">todos</h1>
          <div data-testid="todo-count">{state.todos.length}</div>
        </div>
      );
    };

    const screen = render(
      <StrictMode>
        <TestComponent />
      </StrictMode>
    );

    await expect
      .element(screen.getByTestId("title"))
      .toHaveTextContent("todos");
    await expect
      .element(screen.getByTestId("todo-count"))
      .toHaveTextContent("0");
  });

  it("updates UI when state changes via onStateUpdate", async () => {
    const TestComponent = () => {
      const [state, setState] = React.useState<TodoState>({
        todos: [],
        filter: "all"
      });

      useAgent<TodoState>({
        agent: "todo-agent",
        onStateUpdate: (newState) => {
          setState(newState);
        }
      });

      return (
        <div>
          <div data-testid="todo-count">{state.todos.length}</div>
          <div data-testid="filter">{state.filter}</div>
        </div>
      );
    };

    const screen = render(
      <StrictMode>
        <TestComponent />
      </StrictMode>
    );

    expect(onStateUpdateCallback).toBeDefined();

    const newState: TodoState = {
      todos: [
        {
          id: "1",
          text: "Test todo",
          completed: false,
          createdAt: Date.now()
        }
      ],
      filter: "active"
    };

    await act(async () => {
      onStateUpdateCallback?.(newState);
    });

    await expect
      .element(screen.getByTestId("todo-count"))
      .toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("filter"))
      .toHaveTextContent("active");
  });

  it("calls agent.call when adding a todo", async () => {
    const TestComponent = () => {
      const [inputValue, setInputValue] = React.useState("");

      const agent = useAgent<TodoState>({
        agent: "todo-agent",
        onStateUpdate: () => {}
      });

      const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (inputValue.trim()) {
          await agent.call("addTodo", [inputValue.trim()]);
          setInputValue("");
        }
      };

      return (
        <form onSubmit={handleSubmit}>
          <input
            data-testid="todo-input"
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
          />
          <button data-testid="submit-btn" type="submit">
            Add
          </button>
        </form>
      );
    };

    const screen = render(
      <StrictMode>
        <TestComponent />
      </StrictMode>
    );

    const input = screen.getByTestId("todo-input");
    const submitBtn = screen.getByTestId("submit-btn");

    await act(async () => {
      await input.fill("Learn Cloudflare Agents");
      await submitBtn.click();
    });

    expect(mockAgent.call).toHaveBeenCalledWith("addTodo", [
      "Learn Cloudflare Agents"
    ]);
  });

  it("calls agent.call for toggle, delete, and filter operations", async () => {
    const TestComponent = () => {
      const agent = useAgent<TodoState>({
        agent: "todo-agent",
        onStateUpdate: () => {}
      });

      return (
        <div>
          <button
            type="button"
            data-testid="toggle-btn"
            onClick={() => agent.call("toggleTodo", ["todo-1"])}
          >
            Toggle
          </button>
          <button
            type="button"
            data-testid="delete-btn"
            onClick={() => agent.call("deleteTodo", ["todo-1"])}
          >
            Delete
          </button>
          <button
            type="button"
            data-testid="filter-btn"
            onClick={() => agent.call("setFilter", ["completed"])}
          >
            Filter
          </button>
        </div>
      );
    };

    const screen = render(
      <StrictMode>
        <TestComponent />
      </StrictMode>
    );

    await act(async () => {
      await screen.getByTestId("toggle-btn").click();
    });
    expect(mockAgent.call).toHaveBeenCalledWith("toggleTodo", ["todo-1"]);

    await act(async () => {
      await screen.getByTestId("delete-btn").click();
    });
    expect(mockAgent.call).toHaveBeenCalledWith("deleteTodo", ["todo-1"]);

    await act(async () => {
      await screen.getByTestId("filter-btn").click();
    });
    expect(mockAgent.call).toHaveBeenCalledWith("setFilter", ["completed"]);
  });

  it("filters todos correctly based on filter state", async () => {
    const TestComponent = () => {
      const [state, setState] = React.useState<TodoState>({
        todos: [
          {
            id: "1",
            text: "Active todo",
            completed: false,
            createdAt: Date.now()
          },
          {
            id: "2",
            text: "Completed todo",
            completed: true,
            createdAt: Date.now()
          }
        ],
        filter: "all"
      });

      useAgent<TodoState>({
        agent: "todo-agent",
        onStateUpdate: (newState) => {
          setState(newState);
        }
      });

      const filteredTodos = state.todos.filter((todo) => {
        if (state.filter === "active") return !todo.completed;
        if (state.filter === "completed") return todo.completed;
        return true;
      });

      return (
        <div>
          <div data-testid="todo-count">{filteredTodos.length}</div>
          <div data-testid="current-filter">{state.filter}</div>
        </div>
      );
    };

    const screen = render(
      <StrictMode>
        <TestComponent />
      </StrictMode>
    );

    await expect
      .element(screen.getByTestId("todo-count"))
      .toHaveTextContent("2");
    await expect
      .element(screen.getByTestId("current-filter"))
      .toHaveTextContent("all");

    await act(async () => {
      onStateUpdateCallback?.({
        todos: [
          {
            id: "1",
            text: "Active todo",
            completed: false,
            createdAt: Date.now()
          },
          {
            id: "2",
            text: "Completed todo",
            completed: true,
            createdAt: Date.now()
          }
        ],
        filter: "active"
      });
    });

    await expect
      .element(screen.getByTestId("todo-count"))
      .toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("current-filter"))
      .toHaveTextContent("active");
  });
});
