import {
  Session,
  SessionManager,
  createCompactFunction,
  type SessionMessage,
  type SessionProvider
} from "../sessions";
import {
  Session as ExperimentalSession,
  SessionManager as ExperimentalSessionManager,
  type SessionMessage as ExperimentalSessionMessage,
  type SessionProvider as ExperimentalSessionProvider
} from "../experimental/memory/session";
import { createCompactFunction as ExperimentalCreateCompactFunction } from "../experimental/memory/utils";

Session satisfies typeof ExperimentalSession;
ExperimentalSession satisfies typeof Session;
SessionManager satisfies typeof ExperimentalSessionManager;
ExperimentalSessionManager satisfies typeof SessionManager;
createCompactFunction satisfies typeof ExperimentalCreateCompactFunction;
ExperimentalCreateCompactFunction satisfies typeof createCompactFunction;

declare const message: SessionMessage;
message satisfies ExperimentalSessionMessage;

declare const provider: SessionProvider;
provider satisfies ExperimentalSessionProvider;
