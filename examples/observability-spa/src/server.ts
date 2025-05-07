import { AIChatAgent } from "agents/ai-chat-agent";
import { routeAgentRequest } from "agents";
import { nanoid } from "nanoid";
import {
  createDataStreamResponse,
  streamText,
  tool,
  type StreamTextOnFinishCallback,
} from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { env } from "cloudflare:workers";

const model = openai("gpt-4o");

type AgentState = {
  todos: {
    id: string;
    title: string;
    completed: boolean;
  }[];
};

export class TestingAgent extends AIChatAgent<Env, AgentState> {
  initialState: AgentState = {
    todos: [],
  };

  // biome-ignore lint/complexity/noBannedTypes: <explanation>
  async onChatMessage(onFinish: StreamTextOnFinishCallback<{}>) {
    const dataStreamResponse = createDataStreamResponse({
      execute: async (dataStream) => {
        const result = streamText({
          model,
          messages: this.messages,
          system: "You are a helpful assistant that can do various tasks...",
          tools: {
            addTodo: this.addTodo,
            getTodos: this.getTodos,
            completeTodo: this.completeTodo,
            deleteTodo: this.deleteTodo,
          },
          onFinish,
          onError: (error) => console.error("Error while streaming:", error),
          maxSteps: 10,
        });

        result.mergeIntoDataStream(dataStream);
      },
    });

    return dataStreamResponse;
  }

  addTodo = tool({
    description: "add a todo item to the list",
    parameters: z.object({ title: z.string() }),
    execute: async ({ title }) => {
      this.setState({
        todos: [...this.state.todos, { id: nanoid(), title, completed: false }],
      });

      return this.state.todos;
    },
  });

  getTodos = tool({
    description: "get all todos from the list",
    parameters: z.object({}),
    execute: async () => {
      return this.state.todos;
    },
  });

  completeTodo = tool({
    description: "complete a todo item from the list",
    parameters: z.object({ id: z.string() }),
    execute: async ({ id }) => {
      this.setState({
        todos: this.state.todos.map((todo) =>
          todo.id === id ? { ...todo, completed: true } : todo
        ),
      });

      return this.state.todos;
    },
  });

  deleteTodo = tool({
    description: "delete a todo item from the list",
    parameters: z.object({ id: z.string() }),
    execute: async ({ id }) => {
      this.setState({
        todos: this.state.todos.filter((todo) => todo.id !== id),
      });

      return this.state.todos;
    },
  });
}
export default {
  async fetch(request: Request) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
};
