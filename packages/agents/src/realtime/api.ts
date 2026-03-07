export const REALTIME_AGENTS_SERVICE = "https://agents.realtime.cloudflare.com";

export type CreatePipelineResponse = {
  id: string;
  token: string;
  elements: Record<string, unknown>[];
};

export type CreatePipelineOptions = {
  elements: Record<string, unknown>[];
  layers: {
    id: number;
    name: string;
    elements: string[];
  }[];
};

export class RealtimeAPI {
  gateway: AiGateway;
  constructor(ai: Ai, gatewayId: string) {
    this.gateway = ai.gateway(gatewayId);
  }

  async createPipeline(
    options: CreatePipelineOptions
  ): Promise<CreatePipelineResponse> {
    const response = await this.gateway.run({
      provider: "realtime-agent-internal",
      endpoint: "/agents/pipeline",
      query: options,
      headers: {
        "cf-aig-beta": "true",
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to create pipeline: ${await response.text()}`);
    }

    const data = (await response.json()) as CreatePipelineResponse;
    if (!data.id || !data.token) {
      throw new Error("Invalid response from pipeline provision endpoint");
    }

    return data;
  }

  async startPipeline(authToken: string): Promise<void> {
    await this.#pipelineAction(authToken, "start");
  }

  async stopPipeline(authToken: string): Promise<void> {
    await this.#pipelineAction(authToken, "stop");
  }

  async #pipelineAction(authToken: string, action: "start" | "stop") {
    const response = await this.gateway.run({
      provider: "realtime-agent-internal",
      endpoint: `/agents/pipeline?authToken=${authToken}`,
      query: {
        action: action
      },
      headers: {
        "cf-aig-beta": "true",
        "Content-Type": "application/json"
      },
      // TODO: update types for aig binding workerd
      // method is supported in ai gateway universal request
      method: "PUT"
    } as AIGatewayUniversalRequest);

    if (!response.ok) {
      throw new Error(
        `Failed to ${action} pipeline: ${response.status} ${response.statusText}`
      );
    }

    const { success } = (await response.json()) as { success: boolean };
    if (!success) {
      throw new Error(`Pipeline ${action} action reported failure`);
    }
  }
}
