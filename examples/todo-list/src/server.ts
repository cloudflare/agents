import {
  Agent,
  type AgentNamespace,
  callable,
  routeAgentRequest
} from "agents";

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
  filter: "all" | "active" | "completed";
};

export class TodoAgent extends Agent<Env, TodoState> {
  initialState: TodoState = {
    todos: [],
    filter: "all"
  };

  @callable()
  async addTodo(text: string) {
    const newTodo: Todo = {
      id: crypto.randomUUID(),
      text,
      completed: false,
      createdAt: Date.now()
    };

    this.setState({
      ...this.state,
      todos: [...this.state.todos, newTodo]
    });
  }

  @callable()
  async toggleTodo(id: string) {
    this.setState({
      ...this.state,
      todos: this.state.todos.map((todo) =>
        todo.id === id ? { ...todo, completed: !todo.completed } : todo
      )
    });
  }

  @callable()
  async deleteTodo(id: string) {
    this.setState({
      ...this.state,
      todos: this.state.todos.filter((todo) => todo.id !== id)
    });
  }

  @callable()
  async updateTodoText(id: string, text: string) {
    this.setState({
      ...this.state,
      todos: this.state.todos.map((todo) =>
        todo.id === id ? { ...todo, text } : todo
      )
    });
  }

  @callable()
  async clearCompleted() {
    this.setState({
      ...this.state,
      todos: this.state.todos.filter((todo) => !todo.completed)
    });
  }

  @callable()
  async setFilter(filter: "all" | "active" | "completed") {
    this.setState({
      ...this.state,
      filter
    });
  }

  @callable()
  async toggleAll() {
    const allCompleted = this.state.todos.every((todo) => todo.completed);
    this.setState({
      ...this.state,
      todos: this.state.todos.map((todo) => ({
        ...todo,
        completed: !allCompleted
      }))
    });
  }

  @callable()
  getState(): TodoState {
    return this.state;
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
