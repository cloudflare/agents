// Example adapted from https://github.com/a2aproject/a2a-js/blob/main/src/samples/agents/movie-agent/index.ts

import type {
  A2ARequestHandler,
  AgentCard,
  Message,
  MessageSendParams,
  Task,
  TaskArtifactUpdateEvent,
  TaskIdParams,
  TaskPushNotificationConfig,
  TaskQueryParams,
  TaskStatusUpdateEvent
} from "@a2a-js/sdk";
import { Agent, getAgentByName } from "agents";
import { Hono } from "hono";
import { A2AHonoApp } from "./app";

type Env = {
  MyA2A: DurableObjectNamespace<MyA2A>;
};

type State = {
  tasks: { [id: string]: Task };
};

const agentCard: AgentCard = {
  capabilities: {
    pushNotifications: false,
    stateTransitionHistory: true,
    streaming: true
  },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text", "task-status"],
  description: "Use Cloudflare Agents SDK as an A2A agent.",
  name: "Cloudflare A2A Agent",
  provider: {
    organization: "Cloudflare",
    url: "https://developers.cloudflare.com/agents"
  },
  security: undefined,
  securitySchemes: undefined,
  skills: [
    {
      description: "Process messages using persistent agent state.",
      examples: [
        "Hello, how are you?",
        "What can you help me with?",
        "Tell me about yourself."
      ],
      id: "general_chat",
      inputModes: ["text"],
      name: "General Chat",
      outputModes: ["text", "task-status"],
      tags: ["chat", "general"]
    }
  ],
  supportsAuthenticatedExtendedCard: false,
  url: "http://localhost:5173/",
  version: "0.1.0"
};

// A2A Agent that implements A2ARequestHandler directly
export class MyA2A extends Agent<Env, State> implements A2ARequestHandler {
  initialState = {
    tasks: {}
  };

  private generateId(): string {
    return crypto.randomUUID();
  }

  // A2ARequestHandler implementation
  async getAgentCard(): Promise<AgentCard> {
    return agentCard;
  }

  async sendMessage(params: MessageSendParams): Promise<Message | Task> {
    const incomingMessage = params.message;
    const taskId = incomingMessage.taskId || this.generateId();
    const contextId = incomingMessage.contextId || this.generateId();

    // Create task
    const task: Task = {
      contextId,
      history: [incomingMessage],
      id: taskId,
      kind: "task",
      status: {
        state: "working",
        timestamp: new Date().toISOString()
      }
    };

    // Save task to state
    this.setState({
      ...this.state,
      tasks: {
        ...this.state.tasks,
        [taskId]: task
      }
    });

    // Process the message
    const responseText = `Echo: ${incomingMessage.parts.map((p) => (p.kind === "text" ? p.text : "")).join("")}`;

    const responseMessage: Message = {
      contextId,
      kind: "message",
      messageId: this.generateId(),
      parts: [{ kind: "text", text: responseText }],
      role: "agent",
      taskId
    };

    // Update task
    const completedTask: Task = {
      ...task,
      history: task.history
        ? [...task.history, responseMessage]
        : [responseMessage],
      status: {
        message: responseMessage,
        state: "completed",
        timestamp: new Date().toISOString()
      }
    };

    this.setState({
      ...this.state,
      tasks: {
        ...this.state.tasks,
        [taskId]: completedTask
      }
    });

    return completedTask;
  }

  async *sendMessageStream(
    params: MessageSendParams
  ): AsyncGenerator<
    Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent,
    void,
    undefined
  > {
    const incomingMessage = params.message;
    const taskId = incomingMessage.taskId || this.generateId();
    const contextId = incomingMessage.contextId || this.generateId();

    // Create initial task
    const task: Task = {
      contextId,
      history: [incomingMessage],
      id: taskId,
      kind: "task",
      status: {
        state: "working",
        timestamp: new Date().toISOString()
      }
    };

    this.setState({
      ...this.state,
      tasks: {
        ...this.state.tasks,
        [taskId]: task
      }
    });

    // Yield initial task
    yield task;

    // Yield working status
    yield {
      contextId,
      final: false,
      kind: "status-update",
      status: {
        state: "working",
        timestamp: new Date().toISOString()
      },
      taskId
    } as TaskStatusUpdateEvent;

    // Process the message
    const responseText = `Echo: ${incomingMessage.parts.map((p) => (p.kind === "text" ? p.text : "")).join("")}`;

    const responseMessage: Message = {
      contextId,
      kind: "message",
      messageId: this.generateId(),
      parts: [{ kind: "text", text: responseText }],
      role: "agent",
      taskId
    };

    // Yield response message
    yield responseMessage;

    // Update task
    const completedTask: Task = {
      ...task,
      history: task.history
        ? [...task.history, responseMessage]
        : [responseMessage],
      status: {
        message: responseMessage,
        state: "completed",
        timestamp: new Date().toISOString()
      }
    };

    this.setState({
      ...this.state,
      tasks: {
        ...this.state.tasks,
        [taskId]: completedTask
      }
    });

    // Yield final status
    yield {
      contextId,
      final: true,
      kind: "status-update",
      status: completedTask.status,
      taskId
    } as TaskStatusUpdateEvent;
  }

  async getTask(params: TaskQueryParams): Promise<Task> {
    const task = this.state.tasks[params.id];
    if (!task) {
      throw new Error(`Task not found: ${params.id}`);
    }

    let resultTask = task;
    if (params.historyLength !== undefined && params.historyLength >= 0) {
      resultTask = {
        ...task,
        history: task.history ? task.history.slice(-params.historyLength) : []
      };
    }

    return resultTask;
  }

  async cancelTask(params: TaskIdParams): Promise<Task> {
    const task = this.state.tasks[params.id];
    if (!task) {
      throw new Error(`Task not found: ${params.id}`);
    }

    const nonCancelableStates = ["completed", "failed", "canceled", "rejected"];
    if (nonCancelableStates.includes(task.status.state)) {
      throw new Error(
        `Task ${params.id} cannot be canceled (current state: ${task.status.state})`
      );
    }

    const cancelMessage: Message = {
      contextId: task.contextId,
      kind: "message",
      messageId: this.generateId(),
      parts: [{ kind: "text", text: "Task cancellation requested by user." }],
      role: "agent",
      taskId: task.id
    };

    const canceledTask: Task = {
      ...task,
      history: task.history
        ? [...task.history, cancelMessage]
        : [cancelMessage],
      status: {
        message: cancelMessage,
        state: "canceled",
        timestamp: new Date().toISOString()
      }
    };

    this.setState({
      ...this.state,
      tasks: {
        ...this.state.tasks,
        [params.id]: canceledTask
      }
    });

    return canceledTask;
  }

  async setTaskPushNotificationConfig(
    _params: TaskPushNotificationConfig
  ): Promise<TaskPushNotificationConfig> {
    throw new Error("Push notifications not supported");
  }

  async getTaskPushNotificationConfig(
    _params: TaskIdParams
  ): Promise<TaskPushNotificationConfig> {
    throw new Error("Push notifications not supported");
  }

  async *resubscribe(
    params: TaskIdParams
  ): AsyncGenerator<
    Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent,
    void,
    undefined
  > {
    // Get current task state
    const task = await this.getTask(params);
    yield task;

    // If task is final, no more events
    const finalStates = ["completed", "failed", "canceled", "rejected"];
    if (finalStates.includes(task.status.state)) {
      return;
    }

    // TODO: Implement live updates
    console.log(
      "Resubscribe: Task is not in final state, but no live updates available"
    );
  }

  // Handle HTTP requests for A2A endpoints
  async onRequest(request: Request): Promise<Response> {
    // Setup A2A routes using this agent as the request handler
    const appBuilder = new A2AHonoApp(this);
    const app = appBuilder.setupRoutes(new Hono());

    return app.fetch(request);
  }
}

export default {
  async fetch(request: Request, env: Env) {
    console.log("Worker fetch called");

    const agent = await getAgentByName(env.MyA2A, "default");
    return agent.fetch(request);
  }
} satisfies ExportedHandler<Env>;
