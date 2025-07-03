import { env } from "cloudflare:workers";
import { openai } from "@ai-sdk/openai";
import { type AgentNamespace, routeAgentRequest } from "agents";
import { AIChatAgent } from "agents/ai-chat-agent";
import {
  createDataStreamResponse,
  type StreamTextOnFinishCallback,
  streamText,
  tool,
} from "ai";
import { nanoid } from "nanoid";
import { z } from "zod";

const model = openai("gpt-4o");

type AgentState = {
  todos: {
    id: string;
    title: string;
    completed: boolean;
  }[];
};

type Env = {
  TestingAgent: AgentNamespace<TestingAgent>;
};

export class TestingAgent extends AIChatAgent<Env, AgentState> {
  initialState: AgentState = {
    todos: [],
  };

  async onChatMessage(onFinish: StreamTextOnFinishCallback<{}>) {
    const dataStreamResponse = createDataStreamResponse({
      execute: async (dataStream) => {
        const result = streamText({
          maxSteps: 10,
          messages: this.messages,
          model,
          onError: (error) => console.error("Error while streaming:", error),
          onFinish,
          system: "You are a helpful assistant that can do various tasks...",
          tools: {
            addTodo: this.addTodo,
            completeTodo: this.completeTodo,
            deleteTodo: this.deleteTodo,
            getTodos: this.getTodos,
          },
        });

        result.mergeIntoDataStream(dataStream);
      },
    });

    return dataStreamResponse;
  }

  addTodo = tool({
    description: "add a todo item to the list",
    execute: async ({ title }) => {
      this.setState({
        todos: [...this.state.todos, { completed: false, id: nanoid(), title }],
      });

      return this.state.todos;
    },
    parameters: z.object({ title: z.string() }),
  });

  getTodos = tool({
    description: "get all todos from the list",
    execute: async () => {
      return this.state.todos;
    },
    parameters: z.object({}),
  });

  completeTodo = tool({
    description: "complete a todo item from the list",
    execute: async ({ id }) => {
      this.setState({
        todos: this.state.todos.map((todo) =>
          todo.id === id ? { ...todo, completed: true } : todo
        ),
      });

      return this.state.todos;
    },
    parameters: z.object({ id: z.string() }),
  });

  deleteTodo = tool({
    description: "delete a todo item from the list",
    execute: async ({ id }) => {
      this.setState({
        todos: this.state.todos.filter((todo) => todo.id !== id),
      });

      return this.state.todos;
    },
    parameters: z.object({ id: z.string() }),
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
