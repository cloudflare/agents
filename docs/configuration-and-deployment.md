# Configuration and Deployment

This guide outlines the necessary steps to configure your `wrangler.toml` file for projects using `agents-sdk` and `hono-agents`. Proper configuration ensures that your agents function correctly within the Cloudflare Workers environment.

## `wrangler.toml` Configuration

The `wrangler.toml` file is the configuration file for Cloudflare Workers. It defines various settings, including Durable Objects bindings, migrations, and other deployment considerations.

### Durable Objects Bindings

Durable Objects provide stateful instances for your agents. You need to declare bindings in your `wrangler.toml` to link agent classes to Durable Objects. Each agent class that requires persistence should have a corresponding binding.

```toml
[durable_objects]
bindings = [
  { name = "ChatAgent", class_name: "ChatAgent" },
  { name = "AssistantAgent", class_name = "AssistantAgent" }
]
```

In this example:

- `name`: Specifies the name of the Durable Object binding. This name will be used in your code to access the Durable Object namespace.
- `class_name`: Specifies the name of the agent class that this Durable Object binding is associated with. This must match the class name defined in your agent's code.

**Important:** Ensure that the `name` is distinct and follows naming conventions suitable for your project. The `class_name` must exactly match the name of your Agent class.

### Migrations

Migrations are essential for managing the schema of your Durable Object's storage (e.g., SQLite databases). They allow you to evolve your agent's data structure over time.

```toml
[[migrations]]
tag = "v1"
new_sqlite_classes = ["ChatAgent", "AssistantAgent"]
```

- `tag`: Represents the version of the migration. Increment this tag whenever you make changes to your database schema.
- `new_sqlite_classes`: Lists the agent classes that use SQLite for storage. This ensures that the necessary tables are created during deployment.

**Note:** Migrations are crucial for maintaining data consistency across deployments. Always create a new migration when you modify your agent's data schema. See [core-agent-functionality.md](core-agent-functionality.md) for more information on using SQLite with Agents.

### Example `wrangler.toml`

Here's a complete example of a `wrangler.toml` file configured for `agents-sdk` and `hono-agents`:

```toml
name = "my-agents-project"
type = "javascript"

account_id = "YOUR_ACCOUNT_ID"
workers_dev = true
route = ''
zone_id = "YOUR_ZONE_ID"

compatibility_date = "2024-01-01"

[durable_objects]
bindings = [
  { name = "ChatAgent", class_name = "ChatAgent" },
  { name = "AssistantAgent", class_name = "AssistantAgent" }
]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ChatAgent", "AssistantAgent"]

[vars]
# Define any environment variables your agents need here
OPENAI_API_KEY = "YOUR_OPENAI_API_KEY"

[build]
command = "npm run build"

[build.upload]
format = "modules"
```

Replace `YOUR_ACCOUNT_ID`, `YOUR_ZONE_ID`, and `YOUR_OPENAI_API_KEY` with your actual Cloudflare account ID, zone ID, and OpenAI API key, respectively.

### Deployment Considerations

- **Environment Variables:** Use the `[vars]` section to define environment variables that your agents need, such as API keys or configuration settings. These are accessible within your Agent class via `this.env`.
- **Build Process:** The `[build]` section specifies the command to build your project. Ensure that this command correctly compiles your TypeScript code into JavaScript.
- **Compatibility Date:** Set the `compatibility_date` to a recent date to ensure that your Worker uses the latest features and security updates.
- **Workers Sites:** If you are using Workers Sites to serve static assets, configure the `[site]` section accordingly.

### Verifying the Configuration

After configuring your `wrangler.toml` file, verify that the Durable Objects bindings and migrations are correctly set up by running:

```bash
wrangle dev
```

This command starts a local development server, allowing you to test your agents before deploying them to production.

### Troubleshooting

- **Durable Object Not Found:** If you encounter errors related to Durable Objects not being found, double-check that the `name` and `class_name` in your `wrangler.toml` match the names used in your code.
- **Migration Errors:** If you encounter migration errors, ensure that your migration tag is incremented and that the `new_sqlite_classes` list is up-to-date.
- **Incorrect Environment Variables:** If your agents are not behaving as expected, verify that the environment variables are correctly defined in the `[vars]` section and that your agent code is accessing them correctly.

By following these guidelines, you can effectively configure and deploy your `agents-sdk` and `hono-agents` projects on Cloudflare Workers, ensuring that your agents operate reliably and efficiently.
