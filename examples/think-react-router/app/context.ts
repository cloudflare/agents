import { createContext } from "react-router";

export interface CloudflareLoadContext {
  env: Cloudflare.Env;
  ctx: ExecutionContext;
}

export const cloudflareContext = createContext<CloudflareLoadContext>();
