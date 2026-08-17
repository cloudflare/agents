import {
  act,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";
import { STORAGE_KEY } from "./useTodos";

type RegisteredTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
  };
  execute: (args: unknown) => Promise<unknown>;
};

function installModelContext() {
  const tools = new Map<string, RegisteredTool>();
  const modelContext = {
    async registerTool(
      tool: RegisteredTool,
      options: { signal?: AbortSignal } = {}
    ) {
      tools.set(tool.name, tool);
      options.signal?.addEventListener("abort", () => {
        if (tools.get(tool.name) === tool) tools.delete(tool.name);
      });
    }
  };

  Object.defineProperty(document, "modelContext", {
    configurable: true,
    value: modelContext
  });

  return tools;
}

describe("todo UI", () => {
  it("seeds example todos only when storage is uninitialized", () => {
    const first = render(<App />);
    expect(screen.getByText("Inspect the WebMCP tools")).toBeInTheDocument();
    first.unmount();

    localStorage.setItem(STORAGE_KEY, "[]");
    render(<App />);
    expect(screen.getByText("No todos")).toBeInTheDocument();
    expect(
      screen.queryByText("Inspect the WebMCP tools")
    ).not.toBeInTheDocument();
  });

  it("falls back safely when stored data is invalid", () => {
    localStorage.setItem(STORAGE_KEY, "not valid json");
    render(<App />);
    expect(screen.getByText("Inspect the WebMCP tools")).toBeInTheDocument();
  });

  it("adds, filters, renames, completes, and deletes todos", () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText("Add a todo"), {
      target: { value: "  Ship the demo  " }
    });
    fireEvent.click(screen.getByRole("button", { name: "Add todo" }));
    expect(screen.getByText("Ship the demo")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Rename “Ship the demo”" })
    );
    fireEvent.change(screen.getByLabelText("Rename todo"), {
      target: { value: "Ship the WebMCP demo" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Ship the WebMCP demo")).toBeInTheDocument();

    fireEvent.click(
      screen.getByLabelText("Mark “Ship the WebMCP demo” as completed")
    );
    fireEvent.click(screen.getByRole("button", { name: "Active" }));
    expect(screen.queryByText("Ship the WebMCP demo")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Completed" }));
    expect(screen.getByText("Ship the WebMCP demo")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Delete “Ship the WebMCP demo”" })
    );
    expect(screen.queryByText("Ship the WebMCP demo")).not.toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain(
      "Ship the WebMCP demo"
    );
  });

  it("shows an actionable validation error", () => {
    render(<App />);
    fireEvent.submit(
      screen.getByRole("button", { name: "Add todo" }).closest("form")!
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Todo text is required."
    );
  });
});

describe("WebMCP tools", () => {
  it("explains how to enable WebMCP when the API is unavailable", () => {
    render(<App />);
    expect(
      screen.getByText("WebMCP testing is not enabled")
    ).toBeInTheDocument();
    expect(
      screen.getByText(/chrome:\/\/flags\/#enable-webmcp-testing/)
    ).toBeInTheDocument();
  });

  it("registers four imperative tools and declares the add form", async () => {
    const tools = installModelContext();
    render(<App />);

    await waitFor(() =>
      expect(screen.getByText("WebMCP tools ready")).toBeInTheDocument()
    );
    expect([...tools.keys()].sort()).toEqual([
      "delete_todo",
      "list_todos",
      "rename_todo",
      "set_todo_completed"
    ]);

    const listTool = tools.get("list_todos")!;
    expect(listTool.annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: true
    });
    expect(listTool.description).toMatch(/List todos/);

    const addForm = screen
      .getByRole("button", { name: "Add todo" })
      .closest("form");
    expect(addForm).toHaveAttribute("toolname", "add_todo");
    expect(addForm).toHaveAttribute(
      "tooldescription",
      "Add one active todo to the current list."
    );
    expect(addForm).toHaveAttribute("toolautosubmit");

    const textInput = screen.getByLabelText("Add a todo");
    expect(textInput).toHaveAttribute("name", "text");
    expect(textInput).toBeRequired();
    expect(textInput).toHaveAttribute("maxlength", "200");
    expect(textInput).toHaveAttribute(
      "toolparamdescription",
      "The todo text, between 1 and 200 characters."
    );
  });

  it("uses the declarative form and imperative tools against shared state", async () => {
    const tools = installModelContext();
    render(<App />);
    await waitFor(() => expect(tools.size).toBe(4));

    const textInput = screen.getByLabelText("Add a todo") as HTMLInputElement;
    textInput.value = "Added by an agent";
    let responsePromise: Promise<unknown> | undefined;
    const submitEvent = new SubmitEvent("submit", {
      bubbles: true,
      cancelable: true
    });
    Object.defineProperties(submitEvent, {
      agentInvoked: { value: true },
      respondWith: {
        value(response: Promise<unknown>) {
          responsePromise = response;
        }
      }
    });
    await act(async () => {
      screen
        .getByRole("button", { name: "Add todo" })
        .closest("form")!
        .dispatchEvent(submitEvent);
    });
    const addResult = (await responsePromise) as {
      message: string;
      todo: { id: string; text: string };
    };
    expect(addResult.message).toBe("Todo added.");
    expect(addResult.todo.text).toBe("Added by an agent");
    expect(screen.getByText("Added by an agent")).toBeInTheDocument();

    let completeResult!: { message: string };
    await act(async () => {
      completeResult = (await tools.get("set_todo_completed")!.execute({
        id: addResult.todo.id,
        completed: true
      })) as { message: string };
    });
    expect(completeResult.message).toBe("Todo completed.");
    expect(
      screen.getByLabelText("Mark “Added by an agent” as active")
    ).toBeChecked();

    const listed = (await tools.get("list_todos")!.execute({
      status: "completed"
    })) as { count: number };
    expect(listed.count).toBe(2);

    await expect(
      tools.get("delete_todo")!.execute({ id: "missing-id" })
    ).rejects.toThrow("was not found");

    await expect(
      tools.get("rename_todo")!.execute({
        id: addResult.todo.id,
        text: ""
      })
    ).rejects.toThrow("Todo text is required");
  });

  it("unregisters tools when the app unmounts", async () => {
    const tools = installModelContext();
    const view = render(<App />);
    await waitFor(() => expect(tools.size).toBe(4));
    view.unmount();
    expect(tools.size).toBe(0);
  });

  it("surfaces browser registration failures", async () => {
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool() {
          return Promise.reject(new Error("Tools are blocked on this page."));
        }
      }
    });
    render(<App />);
    await waitFor(() =>
      expect(screen.getByText("WebMCP registration failed")).toBeInTheDocument()
    );
    expect(
      screen.getByText("Tools are blocked on this page.")
    ).toBeInTheDocument();
  });
});
