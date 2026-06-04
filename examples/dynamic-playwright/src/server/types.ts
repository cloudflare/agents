import type { BrowserSession } from "./browser-session";
import type { Project } from "./project";

export type BrowserTarget = {
  id: string;
  type: string;
  url: string;
  title: string;
  devtoolsFrontendUrl?: string;
};

export type LiveViewTarget = {
  id: string;
  url: string;
  title: string;
  devtoolsFrontendUrl: string;
};

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type SessionMetadata = {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
};

export type SessionsResponse = {
  sessions: SessionMetadata[];
};

export type BrowserEnv = {
  BROWSER: Fetcher;
};

export type RunnerEnv = BrowserEnv & {
  LOADER: WorkerLoader;
};

export type Env = RunnerEnv & {
  BROWSER_SESSION: DurableObjectNamespace<BrowserSession>;
  PROJECT: DurableObjectNamespace<Project>;
};
