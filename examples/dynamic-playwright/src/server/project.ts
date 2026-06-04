import { Agent, getAgentByName } from "agents";
import { browserSession, isExpiredSessionRun } from "./browser-session";
import { createBrowserSession } from "./browser-sessions";
import type { Env, JsonValue, LiveViewTarget, SessionMetadata } from "./types";

export const DEFAULT_PROJECT_ID = "default";

export type ProjectState = {
  projectId: string;
  sessions: SessionMetadata[];
  targetsBySessionId: Record<string, LiveViewTarget[]>;
};

export class Project extends Agent<Env, ProjectState> {
  initialState: ProjectState = {
    projectId: DEFAULT_PROJECT_ID,
    sessions: [],
    targetsBySessionId: {}
  };

  addSession(sessionId: string): SessionMetadata {
    const now = Date.now();
    const existingSession = this.state.sessions.find(
      (session) => session.sessionId === sessionId
    );
    const session = existingSession
      ? { ...existingSession, updatedAt: now }
      : { sessionId, createdAt: now, updatedAt: now };

    this.setState({
      ...this.state,
      sessions: upsertSession(this.state.sessions, session),
      targetsBySessionId: {
        ...this.state.targetsBySessionId,
        [sessionId]: this.state.targetsBySessionId[sessionId] ?? []
      }
    });

    return session;
  }

  async createSession(): Promise<SessionMetadata> {
    const sessionId = await createBrowserSession(this.env);
    const session = this.addSession(sessionId);
    await this.refreshTargets(sessionId);
    return session;
  }

  removeSession(sessionId: string): SessionMetadata[] {
    const { [sessionId]: _removedTargets, ...targetsBySessionId } =
      this.state.targetsBySessionId;
    const sessions = this.state.sessions.filter(
      (session) => session.sessionId !== sessionId
    );

    this.setState({
      ...this.state,
      sessions,
      targetsBySessionId
    });

    return sessions;
  }

  updateTargets(
    sessionId: string,
    targets: LiveViewTarget[]
  ): LiveViewTarget[] {
    this.setState({
      ...this.state,
      sessions: touchSession(this.state.sessions, sessionId),
      targetsBySessionId: {
        ...this.state.targetsBySessionId,
        [sessionId]: targets
      }
    });

    return targets;
  }

  async refreshTargets(sessionId: string): Promise<LiveViewTarget[]> {
    try {
      const targets = await browserSession(this.env, sessionId).targets();
      return this.updateTargets(sessionId, targets);
    } catch (error) {
      this.removeSession(sessionId);
      throw error;
    }
  }

  async runScript(
    sessionId: string,
    scriptCode: string
  ): Promise<{ run: JsonValue; sessionId: string | null }> {
    try {
      const runner = browserSession(
        this.env,
        sessionId
      ) as unknown as BrowserSessionRunStub;
      const result = await runner.run(scriptCode);
      this.updateTargets(sessionId, result.targets);

      if (isExpiredSessionRun(result.run)) {
        this.removeSession(sessionId);
        return { ...result, sessionId: null };
      }

      return result;
    } catch (error) {
      this.removeSession(sessionId);
      throw error;
    }
  }

  async closeSession(sessionId: string): Promise<SessionMetadata[]> {
    await browserSession(this.env, sessionId).close();
    return this.removeSession(sessionId);
  }

  listSessions(): SessionMetadata[] {
    return this.state.sessions;
  }
}

type BrowserSessionRunStub = {
  run(
    scriptCode: string
  ): Promise<{ run: JsonValue; sessionId: string; targets: LiveViewTarget[] }>;
};

function upsertSession(
  sessions: SessionMetadata[],
  session: SessionMetadata
): SessionMetadata[] {
  const nextSessions = sessions.filter(
    (existingSession) => existingSession.sessionId !== session.sessionId
  );
  nextSessions.push(session);
  return nextSessions.sort((left, right) => left.createdAt - right.createdAt);
}

function touchSession(
  sessions: SessionMetadata[],
  sessionId: string
): SessionMetadata[] {
  const now = Date.now();
  return sessions.map((session) =>
    session.sessionId === sessionId ? { ...session, updatedAt: now } : session
  );
}

export async function project(env: Env): Promise<DurableObjectStub<Project>> {
  return await getAgentByName<Env, Project>(env.PROJECT, DEFAULT_PROJECT_ID);
}
