# MCP Client Demo Using Agents

A minimal example showing an `Agent` as an MCP client.

## Instructions

First, start an MCP server. A simple example can be found in `examples/mcp`, which already has a valid binding setup.

Then, follow the steps below to setup the client:

1. This example uses a pre-built version of the agents package. Run `npm run build` in the root of this repo to build it.
2. Copy the `.dev.vars.example` file in this directory to a new file called `.dev.vars`.
3. Run `npm install` from this directory.
4. Run `npm start` from this directory.

Tap "O + enter" to open the front end. It should list out all the tools, prompts, and resources available for each server added.

## Troubleshooting

### TypeError: Cannot read properties of undefined (reading 'connectionState')

Clear the Local Storage cookies in your browser, then restart the client.
