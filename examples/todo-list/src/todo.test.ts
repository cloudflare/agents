import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("TodoAgent", () => {
  describe("State Management", () => {
    it("initializes with empty todos and 'all' filter", async () => {
      const room = crypto.randomUUID();
      const agentStub = env.TodoAgent.get(env.TodoAgent.idFromName(room));

      const state = await agentStub.getState();
      expect(state.todos).toEqual([]);
      expect(state.filter).toBe("all");
    });
  });

  describe("Todo Operations", () => {
    it("adds a new todo with correct properties", async () => {
      const room = crypto.randomUUID();
      const agentStub = env.TodoAgent.get(env.TodoAgent.idFromName(room));

      await agentStub.addTodo("Learn Cloudflare Agents");

      const state = await agentStub.getState();
      expect(state.todos).toHaveLength(1);
      expect(state.todos[0].text).toBe("Learn Cloudflare Agents");
      expect(state.todos[0].completed).toBe(false);
      expect(state.todos[0].id).toBeDefined();
      expect(state.todos[0].createdAt).toBeDefined();
    });

    it("adds multiple todos in order", async () => {
      const room = crypto.randomUUID();
      const agentStub = env.TodoAgent.get(env.TodoAgent.idFromName(room));

      await agentStub.addTodo("First todo");
      await agentStub.addTodo("Second todo");
      await agentStub.addTodo("Third todo");

      const state = await agentStub.getState();
      expect(state.todos).toHaveLength(3);
      expect(state.todos[0].text).toBe("First todo");
      expect(state.todos[1].text).toBe("Second todo");
      expect(state.todos[2].text).toBe("Third todo");
    });

    it("toggles todo completion status", async () => {
      const room = crypto.randomUUID();
      const agentStub = env.TodoAgent.get(env.TodoAgent.idFromName(room));

      await agentStub.addTodo("Toggle me");
      let state = await agentStub.getState();
      const todoId = state.todos[0].id;

      await agentStub.toggleTodo(todoId);
      state = await agentStub.getState();
      expect(state.todos[0].completed).toBe(true);

      await agentStub.toggleTodo(todoId);
      state = await agentStub.getState();
      expect(state.todos[0].completed).toBe(false);
    });

    it("deletes a todo by id", async () => {
      const room = crypto.randomUUID();
      const agentStub = env.TodoAgent.get(env.TodoAgent.idFromName(room));

      await agentStub.addTodo("To be deleted");
      let state = await agentStub.getState();
      const todoId = state.todos[0].id;

      await agentStub.deleteTodo(todoId);
      state = await agentStub.getState();
      expect(state.todos).toHaveLength(0);
    });

    it("deletes only the specified todo", async () => {
      const room = crypto.randomUUID();
      const agentStub = env.TodoAgent.get(env.TodoAgent.idFromName(room));

      await agentStub.addTodo("Keep this");
      await agentStub.addTodo("Delete this");
      await agentStub.addTodo("Keep this too");

      let state = await agentStub.getState();
      const todoToDelete = state.todos[1];

      await agentStub.deleteTodo(todoToDelete.id);
      state = await agentStub.getState();

      expect(state.todos).toHaveLength(2);
      expect(state.todos[0].text).toBe("Keep this");
      expect(state.todos[1].text).toBe("Keep this too");
    });

    it("updates todo text", async () => {
      const room = crypto.randomUUID();
      const agentStub = env.TodoAgent.get(env.TodoAgent.idFromName(room));

      await agentStub.addTodo("Original text");
      let state = await agentStub.getState();
      const todoId = state.todos[0].id;

      await agentStub.updateTodoText(todoId, "Updated text");
      state = await agentStub.getState();

      expect(state.todos[0].text).toBe("Updated text");
      expect(state.todos[0].id).toBe(todoId);
    });

    it("clears all completed todos", async () => {
      const room = crypto.randomUUID();
      const agentStub = env.TodoAgent.get(env.TodoAgent.idFromName(room));

      await agentStub.addTodo("Todo 1");
      await agentStub.addTodo("Todo 2");
      await agentStub.addTodo("Todo 3");

      let state = await agentStub.getState();
      await agentStub.toggleTodo(state.todos[0].id);
      await agentStub.toggleTodo(state.todos[2].id);

      await agentStub.clearCompleted();
      state = await agentStub.getState();

      expect(state.todos).toHaveLength(1);
      expect(state.todos[0].text).toBe("Todo 2");
    });

    it("toggles all todos to completed when some are incomplete", async () => {
      const room = crypto.randomUUID();
      const agentStub = env.TodoAgent.get(env.TodoAgent.idFromName(room));

      await agentStub.addTodo("Todo 1");
      await agentStub.addTodo("Todo 2");

      await agentStub.toggleAll();

      const state = await agentStub.getState();
      expect(state.todos[0].completed).toBe(true);
      expect(state.todos[1].completed).toBe(true);
    });

    it("toggles all todos to incomplete when all are completed", async () => {
      const room = crypto.randomUUID();
      const agentStub = env.TodoAgent.get(env.TodoAgent.idFromName(room));

      await agentStub.addTodo("Todo 1");
      await agentStub.addTodo("Todo 2");

      await agentStub.toggleAll();
      await agentStub.toggleAll();

      const state = await agentStub.getState();
      expect(state.todos[0].completed).toBe(false);
      expect(state.todos[1].completed).toBe(false);
    });
  });

  describe("Filter Management", () => {
    it("updates filter to 'active'", async () => {
      const room = crypto.randomUUID();
      const agentStub = env.TodoAgent.get(env.TodoAgent.idFromName(room));

      await agentStub.setFilter("active");

      const state = await agentStub.getState();
      expect(state.filter).toBe("active");
    });

    it("updates filter to 'completed'", async () => {
      const room = crypto.randomUUID();
      const agentStub = env.TodoAgent.get(env.TodoAgent.idFromName(room));

      await agentStub.setFilter("completed");

      const state = await agentStub.getState();
      expect(state.filter).toBe("completed");
    });

    it("updates filter to 'all'", async () => {
      const room = crypto.randomUUID();
      const agentStub = env.TodoAgent.get(env.TodoAgent.idFromName(room));

      await agentStub.setFilter("completed");
      await agentStub.setFilter("all");

      const state = await agentStub.getState();
      expect(state.filter).toBe("all");
    });
  });

  describe("State Persistence", () => {
    it("maintains state across different stub instances", async () => {
      const room = crypto.randomUUID();
      const agentStub1 = env.TodoAgent.get(env.TodoAgent.idFromName(room));

      await agentStub1.addTodo("Persistent todo");

      const agentStub2 = env.TodoAgent.get(env.TodoAgent.idFromName(room));
      const state = await agentStub2.getState();

      expect(state.todos).toHaveLength(1);
      expect(state.todos[0].text).toBe("Persistent todo");
    });

    it("maintains filter state across different stub instances", async () => {
      const room = crypto.randomUUID();
      const agentStub1 = env.TodoAgent.get(env.TodoAgent.idFromName(room));

      await agentStub1.setFilter("completed");

      const agentStub2 = env.TodoAgent.get(env.TodoAgent.idFromName(room));
      const state = await agentStub2.getState();

      expect(state.filter).toBe("completed");
    });
  });
});
