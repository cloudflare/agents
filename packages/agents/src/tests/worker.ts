export type Env = {
  test: string;
  //P_OBJECT: DurableObjectNamespace<McpAgent>;
};

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return new Response("Hello, world!");
  },
} satisfies ExportedHandler<Env>;
