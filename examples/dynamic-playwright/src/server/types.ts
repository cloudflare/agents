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
  AI: Ai;
  LOADER: WorkerLoader;
};

export type ExplorationTraceEntry = {
  toolName: string;
  input: JsonValue;
  output: JsonValue;
};

export type ExplorationResult = {
  description: string;
  explorationSessionId: string;
  testSessionId: string | null;
  summary: string;
  script: string;
  trace: ExplorationTraceEntry[];
  run: JsonValue;
};

export type Env = RunnerEnv & {
  BROWSER_SESSION: DurableObjectNamespace<BrowserSession>;
  PROJECT: DurableObjectNamespace<Project>;
};
