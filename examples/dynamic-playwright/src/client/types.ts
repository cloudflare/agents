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

export type BrowserSessionState = {
  sessions: Session[];
  selectedSession: Session | null;
  targets: LiveViewTarget[];
  selectedTarget: LiveViewTarget | null;
  runResponse: RunResponse | null;
  error: string | null;
  running: boolean;
  creatingSession: boolean;
  refreshingTargets: boolean;
  stopping: boolean;
  run: (script: string) => Promise<void>;
  createSession: () => Promise<void>;
  stop: (sessionId?: string) => Promise<void>;
  refreshTargets: () => Promise<void>;
  selectSession: (sessionId: string) => void;
};
