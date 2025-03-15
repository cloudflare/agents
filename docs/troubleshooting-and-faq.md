# Troubleshooting and FAQ

This document provides solutions to common issues and answers frequently asked questions about using `agents-sdk` and `hono-agents`. It also includes debugging tips and common pitfalls to avoid.

## Common Issues and Solutions

### 1. Agent Not Responding to HTTP Requests

**Problem:** Your agent is deployed, but it doesn't respond to HTTP requests.

**Possible Causes:**

- **Incorrect Durable Object Binding:** Ensure your `wrangler.toml` file correctly binds the Agent class to a Durable Object name. Double-check the `name` and `class_name` fields.

  ```toml
  [durable_objects]
  bindings = [
    { name = "MyAgent", class_name: "MyAgentClass" }
  ]
  ```

- **Missing `onRequest` Method:** Your Agent class must implement the `onRequest` method to handle HTTP requests. Verify that this method exists and is correctly defined.

  ```typescript
  import { Agent } from "agents-sdk";

  export class MyAgentClass extends Agent {
    async onRequest(request: Request): Promise<Response> {
      return new Response("Hello from my agent!");
    }
  }
  ```

- **Routing Issues (with `hono-agents`):** If you're using `hono-agents`, ensure the middleware is correctly set up and that the request is being routed to the agent. Check the `prefix` option in `agentsMiddleware`.

  ```typescript
  import { agentsMiddleware } from "hono-agents";

  app.use("/agents/*", agentsMiddleware()); // Only routes under /agents/*
  ```

- **CORS Issues:** If you're making requests from a different origin, you might encounter CORS issues. Enable CORS in your `routeAgentRequest` call or `agentsMiddleware` configuration.

  ```typescript
  // agents-sdk
  await routeAgentRequest(request, env, { cors: true });

  // hono-agents
  app.use("*", agentsMiddleware({ options: { cors: true } }));
  ```

**Solution:**

1.  Verify Durable Object bindings in `wrangler.toml`. Redeploy if necessary.
2.  Confirm the `onRequest` method is implemented in your Agent class.
3.  Check routing configuration in `hono-agents` (if applicable).
4.  Enable CORS if needed.

### 2. Agent Not Maintaining State

**Problem:** Your agent's state is not persisting between requests.

**Possible Causes:**

- **Missing Migrations:** You haven't defined migrations in your `wrangler.toml` to initialize the SQLite database for state persistence. Migrations are _required_ for stateful agents.

  ```toml
  [[migrations]]
  tag = "v1"
  new_sqlite_classes = ["MyAgentClass"]
  ```

- **Incorrect State Management:** You're not using the `this.state` and `this.setState` methods correctly to manage the agent's state.

  ```typescript
  async myMethod() {
    this.setState({ counter: (this.state.counter || 0) + 1 });
  }
  ```

- **Durable Object Eviction:** Durable Objects can be evicted from memory if they are inactive for a period. Ensure your agent is actively used or consider strategies to keep it alive (e.g., scheduling periodic tasks).

**Solution:**

1.  Define migrations in `wrangler.toml` including all Agent classes that use state.
2.  Use `this.state` and `this.setState` to manage state within your Agent class.
3.  Consider strategies to prevent Durable Object eviction.

### 3. WebSocket Connection Issues

**Problem:** Clients are unable to connect to the agent via WebSocket.

**Possible Causes:**

- **Incorrect WebSocket Handling:** Your Agent class isn't properly handling WebSocket connections using the `onConnect` and `onMessage` methods.

  ```typescript
  import { Agent } from "agents-sdk";

  export class MyAgentClass extends Agent {
    async onConnect(connection: Connection) {
      connection.accept();
      connection.send("Welcome!");
    }

    async onMessage(connection: Connection, message: WSMessage) {
      connection.send(`You said: ${message}`);
    }
  }
  ```

- **Routing Issues (with `hono-agents`):** Similar to HTTP requests, ensure `hono-agents` is correctly routing WebSocket upgrade requests to your agent.

- **Firewall/Proxy Issues:** Firewalls or proxies might be blocking WebSocket connections. Ensure that WebSocket traffic is allowed.

**Solution:**

1.  Implement `onConnect` and `onMessage` methods in your Agent class to handle WebSocket connections.
2.  Verify routing configuration in `hono-agents` (if applicable).
3.  Check firewall and proxy settings.

### 4. Scheduled Tasks Not Executing

**Problem:** Scheduled tasks defined using `this.schedule` are not running.

**Possible Causes:**

- **Incorrect Cron Syntax:** The cron expression is invalid, preventing the task from being scheduled correctly. Use a cron expression validator to ensure your syntax is correct.

- **Timezone Issues:** Cron expressions are evaluated in UTC. Consider timezone differences when scheduling tasks.

- **Durable Object Eviction:** If the Durable Object is evicted before the scheduled time, the task will not execute. See the previous section on preventing eviction.

- **Callback Function Not Found:** The callback function specified in `this.schedule` does not exist or is not accessible within the Agent class.

**Solution:**

1.  Validate cron expressions using a validator.
2.  Be mindful of timezone differences.
3.  Prevent Durable Object eviction.
4.  Ensure the callback function exists and is accessible.

### 5. AI Chat Agent Issues

**Problem:** Problems with the `AIChatAgent`, such as messages not being sent or received, or errors connecting to the AI service.

**Possible Causes:**

- **Missing API Key:** The API key for the AI service (e.g., OpenAI) is not provided or is incorrect. Ensure the API key is set in the environment variables and accessible to the Agent.

  ```typescript
  const ai = new OpenAI({
    apiKey: this.env.OPENAI_API_KEY,
  });
  ```

- **Incorrect `onChatMessage` Implementation:** The `onChatMessage` method is not correctly implemented, leading to errors in generating or sending responses.

- **Network Issues:** The Agent is unable to connect to the AI service due to network connectivity problems.

**Solution:**

1.  Verify the API key is set correctly in the environment.
2.  Review the `onChatMessage` implementation for errors.
3.  Check network connectivity.

## Frequently Asked Questions (FAQ)

**Q: How do I deploy an `agents-sdk` application?**

**A:** Deploying an `agents-sdk` application involves configuring your `wrangler.toml` file with Durable Object bindings and migrations, then using the `wrangler deploy` command. Refer to the [Configuration and Deployment](configuration-and-deployment.md) documentation for detailed instructions.

**Q: Can I use `agents-sdk` with frameworks other than Hono?**

**A:** Yes, while `hono-agents` provides convenient integration with Hono, `agents-sdk` can be used with other frameworks. You'll need to handle the routing and WebSocket upgrades manually.

**Q: How do I debug my Agent?**

**A:** Use `console.log` statements within your Agent's methods to track the flow of execution and inspect variable values. You can view these logs in the Cloudflare Workers dashboard or using the `wrangler tail` command. Consider using more sophisticated logging libraries for production environments.

**Q: How do I handle errors in my Agent?**

**A:** Use `try...catch` blocks to catch errors within your Agent's methods. Log the errors and return appropriate error responses to the client. For `hono-agents`, you can use the `onError` option in the middleware to handle errors globally.

**Q: How do I test my Agent locally?**

**A:** You can use `wrangler dev` to test your Agent locally. This provides a local development environment that simulates the Cloudflare Workers environment.

**Q: What are the limitations of Durable Objects?**

**A:** Durable Objects have limitations on storage size, CPU time, and network bandwidth. Be mindful of these limitations when designing your Agent.

## Debugging Tips

- **Use `console.log` liberally:** Insert `console.log` statements throughout your code to track execution flow and variable values.
- **Inspect network requests:** Use your browser's developer tools to inspect network requests and responses to identify issues with data transfer.
- **Use `wrangler tail`:** This command streams logs from your deployed Worker, allowing you to see real-time output from your `console.log` statements.
- **Check the Cloudflare Workers dashboard:** The dashboard provides insights into your Worker's performance and error rates.
- **Simplify your code:** If you're encountering complex issues, try simplifying your code to isolate the problem.

## Common Pitfalls to Avoid

- **Forgetting Migrations:** Always define migrations in `wrangler.toml` when using stateful Agents.
- **Incorrect Durable Object Bindings:** Double-check the `name` and `class_name` fields in your Durable Object bindings.
- **Ignoring CORS:** Enable CORS when making requests from different origins.
- **Not Handling Errors:** Use `try...catch` blocks to handle errors gracefully.
- **Over-reliance on AI Slop:** Contributions entirely authored by LLMs are unlikely to meet the quality bar. Use LLMs as tools, not replacements for thoughtful code.

By following these troubleshooting tips and avoiding common pitfalls, you can effectively develop and deploy intelligent agents using `agents-sdk` and `hono-agents`.
