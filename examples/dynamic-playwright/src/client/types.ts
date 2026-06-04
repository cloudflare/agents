export type LiveViewTarget = {
  id: string;
  url: string;
  title: string;
  devtoolsFrontendUrl: string;
};

export type Session = {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
};

export type ProjectState = {
  projectId: string;
  sessions: Session[];
  targetsBySessionId: Record<string, LiveViewTarget[]>;
};

export type RunResponse = {
  result?: unknown;
  error?: string;
  logs?: string[];
  diagnostics?: unknown;
};

export type RunScriptResponse = {
  run: RunResponse;
  runId?: string;
  sessionId: string | null;
};

export type ExplorationTraceEntry = {
  toolName: string;
  input: unknown;
  output: unknown;
};

export type ExplorationResult = {
  description: string;
  explorationSessionId: string;
  testSessionId: string | null;
  summary: string;
  script: string;
  trace: ExplorationTraceEntry[];
  run: RunResponse;
};

export type BrowserSessionState = {
  sessions: Session[];
  selectedSession: Session | null;
  targets: LiveViewTarget[];
  selectedTarget: LiveViewTarget | null;
  runResponse: RunResponse | null;
  error: string | null;
  explorationResponse: ExplorationResult | null;
  running: boolean;
  exploring: boolean;
  creatingSession: boolean;
  refreshingTargets: boolean;
  stopping: boolean;
  run: (script: string) => Promise<void>;
  explore: (description: string) => Promise<ExplorationResult | null>;
  createSession: () => Promise<void>;
  stop: (sessionId?: string) => Promise<void>;
  refreshTargets: () => Promise<void>;
  selectSession: (sessionId: string) => void;
};
