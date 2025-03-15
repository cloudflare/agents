# Getting Started with `agents-sdk`

Welcome to `agents-sdk`, a framework designed to help you build intelligent, stateful AI agents. This guide will walk you through the fundamental concepts and provide a step-by-step process to get you started.

## Core Concepts

`agents-sdk` provides the tools and structure to create AI agents that exhibit the following key characteristics:

- **Persistence**: Agents maintain their state and knowledge over time, allowing them to learn and adapt.
- **Agency**: Agents act autonomously within their defined purpose, making decisions and taking actions without constant human intervention.
- **Connection**: Agents can communicate through multiple channels, interacting with both humans and other agents.
- **Growth**: Agents learn and evolve through their interactions, improving their performance and capabilities over time.

These concepts are built upon the following core principles:

1.  **Stateful Existence**: Each agent maintains its own persistent reality.
2.  **Long-lived Presence**: Agents can run for extended periods, resting when idle.
3.  **Natural Communication**: Interact through HTTP, WebSockets, or direct calls.
4.  **Global Distribution**: Leverage Cloudflare's network for worldwide presence.
5.  **Resource Harmony**: Efficient hibernation and awakening as needed.

## Setting Up Your Project

There are two primary ways to start using `agents-sdk`:

1.  Creating a new project from a template.
2.  Integrating `agents-sdk` into an existing project.

### 1. Creating a New Project

The easiest way to get started is to use the provided Cloudflare Workers template. This template includes all the necessary dependencies and configurations to run `agents-sdk`.

```sh
npm create cloudflare@latest -- --template cloudflare/agents-starter
```

This command will:

- Create a new directory for your project.
- Download the `agents-starter` template.
- Install the necessary dependencies.
- Initialize a Git repository (optional).

Follow the prompts to configure your project. Once the process is complete, you'll have a fully functional `agents-sdk` project ready to go.

### 2. Integrating into an Existing Project

If you have an existing Cloudflare Workers project, you can integrate `agents-sdk` by installing the package:

```sh
npm install agents-sdk
```

This command will install the `agents-sdk` package and its dependencies into your project.

## Creating Your First Agent

Now that you have set up your project, let's create a simple agent that responds to HTTP requests.

1.  **Define the Agent Class**:

    Create a new file (e.g., `src/intelligent-agent.ts`) and define your agent class. This class should extend the `Agent` class from the `agents-sdk`.

    ```ts
    import { Agent } from "agents-sdk";

    export class IntelligentAgent extends Agent {
      async onRequest(request: Request) {
        // Transform intention into response
        return new Response("Ready to assist.");
      }
    }
    ```

    This code defines a simple agent that responds with the message "Ready to assist." to any HTTP request.

2.  **Configure `wrangler.toml`**:

    To enable your agent, you need to configure your `wrangler.toml` file to define a Durable Object binding for your agent.

    ```toml
    [durable_objects]
    bindings = [
      { name = "IntelligentAgent", class_name = "IntelligentAgent" }
    ]

    [[migrations]]
    tag = "v1"
    new_sqlite_classes = ["IntelligentAgent"]
    ```

    This configuration tells Cloudflare Workers to create a Durable Object named `IntelligentAgent` and associate it with the `IntelligentAgent` class you defined.

3.  **Deploy Your Agent**:

    Deploy your worker to Cloudflare.

    ```sh
    npm run deploy
    ```

4.  **Test Your Agent**:

    Send an HTTP request to your worker's URL. You should receive the response "Ready to assist.".

## Next Steps

Congratulations! You've created your first agent with `agents-sdk`. From here, you can explore more advanced features, such as:

- Managing agent state.
- Scheduling tasks.
- Connecting to external services.
- Building AI chat agents.

Refer to the other documentation files for more information on these topics, such as [core-agent-functionality.md](core-agent-functionality.md) and [building-ai-chat-agents.md](building-ai-chat-agents.md).
