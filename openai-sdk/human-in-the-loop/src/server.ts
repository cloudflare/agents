import { Agent, type RunResult, RunState, run, tool } from "@openai/agents";
import { Agent as CFAgent, callable, routeAgentRequest } from "agents";
import { z } from "zod";

const getWeatherTool = tool({
  description: "Get the weather for a given city",
  execute: async ({ location }) => {
    console.log(`[getWeatherTool] Executing weather lookup for: ${location}`);
    const result = `The weather in ${location} is sunny`;
    console.log(`[getWeatherTool] Returning result: ${result}`);
    return result;
  },
  name: "get_weather",
  needsApproval: async (_context, { location }) => {
    console.log(
      `[getWeatherTool] Checking if approval needed for location: ${location}`
    );
    // forces approval to look up the weather in San Francisco
    const needsApproval = location === "San Francisco";
    console.log(`[getWeatherTool] Approval needed: ${needsApproval}`);
    return needsApproval;
  },
  parameters: z.object({
    location: z.string()
  })
});

export type AgentState = {
  serialisedRunState: string | null;
};

export class MyAgent extends CFAgent<Env, AgentState> {
  initialState: AgentState = {
    serialisedRunState: null
  };

  // biome-ignore lint/suspicious/noExplicitAny: OpenAI SDK type compatibility
  result: RunResult<unknown, Agent<unknown, any>> | null = null;
  agent = new Agent({
    instructions: "You are a helpful assistant",
    name: "Assistant",
    tools: [getWeatherTool]
  });

  async onStart() {
    console.log("[MyAgent] onStart called");
    console.log("[MyAgent] Current state:", this.state);

    if (this.state.serialisedRunState) {
      console.log("[MyAgent] Restoring from serialised state");
      const runState = await RunState.fromString(
        this.agent,
        this.state.serialisedRunState
      );
      console.log("[MyAgent] RunState restored:", runState);
      this.result = await run(this.agent, runState);
      console.log("[MyAgent] Agent run completed with result:", this.result);
    } else {
      console.log("[MyAgent] No serialised state found, starting fresh");
    }
  }

  @callable()
  async ask(question: string) {
    console.log(`[MyAgent] ask method called with question: "${question}"`);
    console.log("[MyAgent] Starting agent run...");

    this.result = await run(this.agent, question);

    console.log("[MyAgent] Agent run completed");
    console.log("[MyAgent] Result:", this.result);
    console.log("[MyAgent] Result state:", this.result.state);

    const serialisedState = JSON.stringify(this.result.state, null, 2);
    console.log("[MyAgent] Serialising state:", serialisedState);

    this.setState({
      serialisedRunState: serialisedState
    });

    console.log("[MyAgent] State updated, serialisedRunState saved");
  }

  @callable()
  async proceed(id: string, approval: boolean) {
    console.log(
      `[MyAgent] proceed method called with id: ${id}, approval: ${approval}`
    );

    const runState = await RunState.fromString(
      this.agent,
      this.state.serialisedRunState!
    );
    const interruption = this.result?.interruptions?.find(
      (i) => "callId" in i.rawItem && i.rawItem.callId === id
    );
    if (interruption) {
      if (approval) {
        runState.approve(interruption);
      } else {
        runState.reject(interruption);
      }

      this.result = await run(this.agent, runState);
      const serialisedState = JSON.stringify(this.result.state, null, 2);
      console.log("[MyAgent] Serialising state:", serialisedState);

      this.setState({
        serialisedRunState: serialisedState
      });
    } else {
      throw new Error(`[MyAgent] No interruption found with id: ${id}`);
    }
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    console.log(`[Server] Handling request: ${request.method} ${request.url}`);

    const response = await routeAgentRequest(request, env);

    if (response) {
      console.log(
        `[Server] Agent request routed successfully, status: ${response.status}`
      );
      return response;
    }
    console.log("[Server] No agent route matched, returning 404");
    return new Response("Not found", { status: 404 });
  }
};
