import { useState } from "react";
import { useAgent } from "agents/react";
import {
  createSession as createBrowserSession,
  listSessionTargets,
  runScript,
  stopSession
} from "../api";
import type {
  BrowserSessionState,
  ExplorationResult,
  ProjectState,
  RunResponse,
  Session
} from "../types";

const DEFAULT_PROJECT_ID = "default";
const EMPTY_PROJECT_STATE: ProjectState = {
  projectId: DEFAULT_PROJECT_ID,
  sessions: [],
  targetsBySessionId: {}
};

export function useBrowserSession(): BrowserSessionState {
  const project = useAgent<ProjectState>({
    agent: "project",
    name: DEFAULT_PROJECT_ID
  });
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );
  const [runResponse, setRunResponse] = useState<RunResponse | null>(null);
  const [explorationResponse, setExplorationResponse] =
    useState<ExplorationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [exploring, setExploring] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [refreshingTargets, setRefreshingTargets] = useState(false);
  const [stopping, setStopping] = useState(false);

  const projectState = project.state ?? EMPTY_PROJECT_STATE;
  const sessions = projectState.sessions;
  const selectedSession = chooseSession(sessions, selectedSessionId);
  const targets = selectedSessionId
    ? (projectState.targetsBySessionId[selectedSessionId] ?? [])
    : [];
  const selectedTarget = targets[0] ?? null;

  async function refreshTargets() {
    if (!selectedSession) return;
    setRefreshingTargets(true);
    setError(null);

    try {
      await listSessionTargets(selectedSession.sessionId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRefreshingTargets(false);
    }
  }

  async function run(script: string) {
    if (!selectedSession) {
      setError("Create or select a session before running a script.");
      return;
    }

    setRunning(true);
    setError(null);
    setRunResponse(null);

    try {
      const result = await runScript(script, selectedSession.sessionId);
      setRunResponse(result.run);
      setSelectedSessionId(result.sessionId ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunning(false);
    }
  }

  async function explore(
    description: string
  ): Promise<ExplorationResult | null> {
    setExploring(true);
    setError(null);
    setRunResponse(null);
    setExplorationResponse(null);

    try {
      const result = (await project.call("explore", [
        description
      ])) as ExplorationResult;
      setExplorationResponse(result);
      setRunResponse(result.run);
      setSelectedSessionId(result.testSessionId);
      return result;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    } finally {
      setExploring(false);
    }
  }

  async function createSession() {
    setCreatingSession(true);
    setError(null);

    try {
      const session = await createBrowserSession();
      setSelectedSessionId(session.sessionId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCreatingSession(false);
    }
  }

  async function stop(sessionId = selectedSession?.sessionId) {
    if (!sessionId) return;
    setStopping(true);
    setError(null);

    try {
      await stopSession(sessionId);
      setSelectedSessionId(
        sessionId === selectedSessionId ? null : selectedSessionId
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStopping(false);
    }
  }

  return {
    sessions,
    selectedSession,
    targets,
    selectedTarget,
    runResponse,
    explorationResponse,
    error,
    running,
    exploring,
    creatingSession,
    refreshingTargets,
    stopping,
    run,
    explore,
    createSession,
    stop,
    refreshTargets,
    selectSession: setSelectedSessionId
  };
}

function chooseSession(
  sessions: Session[],
  selectedSessionId: string | null
): Session | null {
  if (!selectedSessionId) return null;
  return (
    sessions.find((session) => session.sessionId === selectedSessionId) ?? {
      sessionId: selectedSessionId,
      createdAt: 0,
      updatedAt: 0
    }
  );
}
