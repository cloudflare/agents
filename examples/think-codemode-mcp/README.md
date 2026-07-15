# Think Code Mode MCP

This example shows the default Think tool model:

- the model sees `read`, `write`, `edit`, and `code` as built-in tools;
- `code` runs JavaScript in a durable Code Mode sandbox;
- a connected MCP server appears as the `catalog.*` namespace;
- MCP schemas are discovered through `codemode.search()` and
  `codemode.describe()` instead of becoming direct model tools.

The Worker contains both sides of the example. `CatalogMcp` is an MCP server
with product lookup tools. `Assistant` connects to it over its Durable Object
binding during `onStart()`.

## Run it

```sh
pnpm install
pnpm start
```

Ask:

> Find products related to Code Mode, then get the details for the first one.

The expected Code Mode workflow is:

```js
async () => {
  const matches = await codemode.search("search products");
  const docs = await codemode.describe("catalog.search_products");
  const { products } = await catalog.search_products({
    query: "Code Mode",
    limit: 5
  });
  const product = products[0]
    ? await catalog.get_product({ id: products[0].id })
    : null;
  return { matches, docs, product };
};
```

## What matters

`addMcpServer("catalog", ...)` establishes the connection. Think builds the
`catalog` connector when it creates `code`; it does not call `mcp.getAITools()`.
Adding a large MCP catalog therefore does not expand the model request's direct
tool schemas.

The Worker Loader binding runs generated code in an isolated Dynamic Worker.
The `@cloudflare/codemode/vite` plugin exports the `CodemodeRuntime` facet used
for durable execution and approval recovery. Think framework projects get the
same export automatically from `think()`.
