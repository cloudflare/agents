declare module "virtual:think/entry" {
  export const ThinkAgent_Support: typeof import("agents").Agent;
  export const ThinkAgent_Sales: typeof import("agents").Agent;
  export const ThinkSubAgent_Support_Researcher: typeof import("agents").Agent;
  export const ThinkSubAgent_Sales_Researcher: typeof import("agents").Agent;
  export const ThinkSubAgent_Sales_Analyst: typeof import("agents").Agent;
  const entry: ExportedHandler<Cloudflare.Env>;
  export default entry;
}

declare module "virtual:think/router" {
  export const thinkRouter: import("../../server-entry").ThinkRouter;
}
