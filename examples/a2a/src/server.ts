// Example adapted from https://github.com/a2aproject/a2a-js/blob/main/src/samples/agents/movie-agent/index.ts

import { type AgentCard, type AgentExecutor, DefaultRequestHandler, type ExecutionEventBus, type RequestContext, type Task, type TaskStore } from "@a2a-js/sdk";
import { Agent, getAgentByName } from "agents";
import { Hono } from "hono";
import { A2AHonoApp } from "./app";

type Env = {
  MyA2A: DurableObjectNamespace<MyA2A>;
  TaskStoreAgent: DurableObjectNamespace<TaskStoreAgent>;
};

type State = { 
  tasks: { [id: string]: Task };
  executionState: { [id: string]: 'running' | 'completed' | 'failed' };
};

export class TaskStoreAgent extends Agent<Env, State> {
  initialState = {
    executionState: {},
    tasks: {}
  };

  async storeTask(task: Task): Promise<void> {
    const newState = {
      ...this.state,
      tasks: {
        ...this.state.tasks,
        [task.id]: task
      }
    };
    this.setState(newState);
  }

  async getTask(id: string): Promise<Task | undefined> {
    return this.state.tasks[id];
  }

  async updateTask(task: Task): Promise<void> {
    await this.storeTask(task);
  }
}

export class MyA2A extends Agent<Env, State> {
  initialState = {
    executionState: {},
    tasks: {}
  };

  async executeTask(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    // Basic task execution - this would be where you integrate with AI models
    const { userMessage } = requestContext;
    
    // Example: Echo back the user's message
    const responseText = `Echo: ${userMessage.parts.map(p => p.kind === 'text' ? p.text : '').join('')}`;
    
    // Publish completion event
    eventBus.publish({
      contextId: userMessage.contextId || 'unknown',
      final: true,
      kind: 'status-update',
      status: {
        message: {
          contextId: userMessage.contextId || 'unknown',
          kind: 'message',
          messageId: `msg_${Date.now()}`,
          parts: [{ kind: 'text', text: responseText }],
          role: 'agent',
          taskId: userMessage.taskId || 'unknown',
        },
        state: 'completed',
        timestamp: new Date().toISOString(),
      },
      taskId: userMessage.taskId || 'unknown',
    });
  }
}

// Agent-based TaskStore implementation
class AgentTaskStore implements TaskStore {
  constructor(private taskStoreAgentNamespace: DurableObjectNamespace<TaskStoreAgent>) {}

  async save(task: Task): Promise<void> {
    const agent = await getAgentByName(this.taskStoreAgentNamespace, 'task-store');
    await agent.storeTask(task);
  }

  async load(id: string): Promise<Task | undefined> {
    const agent = await getAgentByName(this.taskStoreAgentNamespace, 'task-store');
    return await agent.getTask(id);
  }
}

// Agent-based AgentExecutor implementation
class MyA2AAgentExecutor implements AgentExecutor {
  constructor(private agentNamespace: DurableObjectNamespace<MyA2A>) {}

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const contextId = requestContext.userMessage.contextId || 'default';
    const agent = await getAgentByName(this.agentNamespace, `executor-${contextId}`);
    return await agent.executeTask(requestContext, eventBus);
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    // Implementation for task cancellation
    eventBus.publish({
      contextId: 'unknown',
      final: true,
      kind: 'status-update',
      status: {
        state: 'canceled',
        timestamp: new Date().toISOString(),
      },
      taskId,
    });
  }
}

const agentCard: AgentCard = {
  capabilities: {
    pushNotifications: false,
    stateTransitionHistory: true,
    streaming: true,
  },
  defaultInputModes: ['text'],
  defaultOutputModes: ['text', 'task-status'],
  description: 'An agent that uses Cloudflare Agents framework for state management.',
  name: 'Cloudflare A2A Agent',
  provider: {
    organization: 'Cloudflare',
    url: 'https://developers.cloudflare.com/agents'
  },
  security: undefined,
  securitySchemes: undefined,
  skills: [
    {
      description: 'Process messages using persistent agent state.',
      examples: [
        'Hello, how are you?',
        'What can you help me with?',
        'Tell me about yourself.',
      ],
      id: 'general_chat',
      inputModes: ['text'],
      name: 'General Chat',
      outputModes: ['text', 'task-status'],
      tags: ['chat', 'general']
    },
  ],
  supportsAuthenticatedExtendedCard: false,
  url: 'http://localhost:8787/',
  version: '0.1.0',
};

export default {
  async fetch(_request: Request, _env: Env) {
      // 1. Create Agent-based TaskStore
  const taskStore: TaskStore = new AgentTaskStore(_env.TaskStoreAgent);

  // 2. Create Agent-based AgentExecutor
  const agentExecutor: AgentExecutor = new MyA2AAgentExecutor(_env.MyA2A);

  // 3. Create DefaultRequestHandler
  const requestHandler = new DefaultRequestHandler(
    agentCard,
    taskStore,
    agentExecutor
  );

  // 4. Create and setup A2AHonoApp
  const appBuilder = new A2AHonoApp(requestHandler);

  const app = appBuilder.setupRoutes(new Hono())

  return app.fetch(_request);
  },
} satisfies ExportedHandler<Env>;
