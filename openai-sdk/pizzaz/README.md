# ChatGPT Apps

[Reference](https://developers.openai.com/apps-sdk/build/examples)

## Requirements

You'll need a ChatGPT developer account to be able to use ChatGPT apps (connectors). To do so, from ChatGPT go to **Settings -> Apps & Connectors -> Advanced Settings -> Developer mode ON**.

## Usage

We'll be deploying a PizzaMCP that allows us to render a few different pizza-related components.
All ChatGPT App MCPs are ready-to-ship with `agents`.

Run `npm run deploy` and make a note of the URL your worker is hosted at. It should be something like `https://pizzaz-mcp.<your-account>.workers.dev`.

Now, you can go to the ChatGPT interface and add the app as a connector. Simply:

1. Go to **Settings -> Apps & Connectors -> Create**
2. Give it a name and a description (e.g. "Pizzaz" / "Browse and order nearby pizzaz!")
3. Set the `MCP Server URL` to the Worker URL you just deployed.
4. This example uses no authentication, so set `No Authentication`.
5. Carefully read the warning and click `I trust this application`.
6. Click Create and you're ready to start using your app!
