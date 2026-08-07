import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createRlmApi,
  RlmApiError,
  type HistoryMessage,
  type RlmRequest
} from "./api";

const TURN_KEY = "codemode-rlm:turn:";
const PREVIEW_CHARS = 2_000;

export type ActiveTurn = {
  status: "submitting" | "recovering" | "admitted" | "running";
  requestId: string;
  inputId: string;
  task: string;
  notice?: string;
  payload?: { task: string; context: string };
};

export type FailedTurn = {
  status: "failed";
  requestId: string;
  inputId: string;
  task: string;
  error: string;
};

type Turn = ActiveTurn | FailedTurn;
type Options = {
  session: string;
  token: string;
  authRequired: boolean;
  connectionRevision: number;
  onAuthRequired: () => void;
};

function readTurn(session: string): Turn | null {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(`${TURN_KEY}${session}`) ?? "null"
    ) as Partial<Turn> | null;
    if (
      !value ||
      typeof value.requestId !== "string" ||
      typeof value.inputId !== "string" ||
      typeof value.task !== "string"
    ) {
      return null;
    }
    if (value.status === "failed" && typeof value.error === "string") {
      return value as FailedTurn;
    }
    if (
      !["submitting", "recovering", "admitted", "running"].includes(
        String(value.status)
      )
    )
      return null;
    const status = value.status as ActiveTurn["status"];
    return {
      requestId: value.requestId,
      inputId: value.inputId,
      task: value.task,
      status: status === "submitting" ? "recovering" : status,
      ...(status === "submitting" || status === "recovering"
        ? { notice: "Checking whether this request reached durable admission." }
        : {})
    };
  } catch {
    return null;
  }
}

function persist(session: string, turn: Turn | null): void {
  try {
    const key = `${TURN_KEY}${session}`;
    if (!turn) return sessionStorage.removeItem(key);
    sessionStorage.setItem(
      key,
      JSON.stringify({
        ...turn,
        task: turn.task.slice(0, PREVIEW_CHARS),
        payload: undefined,
        notice: undefined,
        ...(turn.status === "failed"
          ? { error: turn.error.slice(0, PREVIEW_CHARS) }
          : {})
      })
    );
  } catch {
    // The request remains durable when browser storage is unavailable.
  }
}

function inputId(message: HistoryMessage): string | undefined {
  const value = message.metadata.inputId;
  return typeof value === "string" ? value : undefined;
}

let localId = 0;

function addCompletion(
  history: HistoryMessage[],
  turn: ActiveTurn,
  result: RlmRequest
): HistoryMessage[] {
  const now = Date.now();
  const retained = history.filter(
    (item) => item.role !== "assistant" || inputId(item) !== result.inputId
  );
  if (!retained.some((item) => inputId(item) === result.inputId)) {
    retained.push({
      id: --localId,
      scope: "root",
      role: "user",
      content: turn.task,
      metadata: { inputId: result.inputId },
      createdAt: now
    });
  }
  retained.push({
    id: --localId,
    scope: "root",
    role: "assistant",
    content: result.answer ?? "",
    metadata: { inputId: result.inputId, requestId: result.requestId },
    createdAt: now
  });
  return retained;
}

function mergeHistory(
  server: HistoryMessage[],
  current: HistoryMessage[]
): HistoryMessage[] {
  const key = (message: HistoryMessage) =>
    `${inputId(message) ?? message.id}:${message.role}`;
  const merged = new Map(server.map((message) => [key(message), message]));
  for (const message of current) {
    if (message.role === "assistant" || !merged.has(key(message))) {
      merged.set(key(message), message);
    }
  }
  return [...merged.values()].sort(
    (left, right) => left.createdAt - right.createdAt
  );
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function useRlmSession({
  session,
  token,
  authRequired,
  connectionRevision,
  onAuthRequired
}: Options) {
  const configured = !authRequired || Boolean(token);
  const [turn, setTurn] = useState<Turn | null>(() => readTurn(session));
  const [history, setHistory] = useState<HistoryMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(configured);
  const [retry, setRetry] = useState(0);
  const turnRef = useRef(turn);
  turnRef.current = turn;
  const api = useMemo(() => {
    void connectionRevision;
    return configured ? createRlmApi(session, token) : null;
  }, [configured, connectionRevision, session, token]);

  const save = useCallback(
    (next: Turn | null) => {
      persist(session, next);
      setTurn(next);
    },
    [session]
  );
  useEffect(() => {
    if (!api) return setLoading(false);
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void api
      .history(controller.signal)
      .then((messages) => {
        const visible = messages
          .filter((item) => item.role === "user" || item.role === "assistant")
          .reverse();
        setHistory((current) => mergeHistory(visible, current));
      })
      .catch((cause: unknown) => {
        if (isAbort(cause)) return;
        setError(text(cause));
        if (cause instanceof RlmApiError && cause.status === 401) {
          onAuthRequired();
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, onAuthRequired]);

  useEffect(() => {
    const current = turnRef.current;
    const active = current?.status === "failed" ? null : current;
    if (!api || !active) return;
    if (active.status === "submitting" && !active.payload) return;

    const controller = new AbortController();
    let timer: number | undefined;
    let missing = 0;
    const schedule = (delay: number) => {
      timer = window.setTimeout(() => void run(), delay);
    };
    const addNotice = (notice: string) => setTurn({ ...active, notice });
    const fail = (reason: string) =>
      save({
        status: "failed",
        requestId: active.requestId,
        inputId: active.inputId,
        task: active.task,
        error: reason
      });
    const apply = (result: RlmRequest): boolean => {
      if (result.status === "completed") {
        setHistory((current) => addCompletion(current, active, result));
        save(null);
        setError(null);
        return true;
      }
      if (result.status === "error") {
        fail(result.error || "The RLM turn failed.");
        setError(null);
        return true;
      }
      setError(null);
      if (
        active.status !== result.status ||
        active.inputId !== result.inputId ||
        active.notice
      ) {
        save({
          status: result.status,
          requestId: result.requestId,
          inputId: result.inputId,
          task: active.task
        });
      }
      return false;
    };
    const run = async () => {
      try {
        const result =
          active.status === "submitting"
            ? await api.submit(
                active.requestId,
                active.payload!.task,
                active.payload!.context,
                controller.signal
              )
            : await api.status(active.requestId, controller.signal);
        if (controller.signal.aborted || apply(result)) return;
        schedule(document.hidden ? 2_500 : 1_000);
      } catch (cause) {
        if (controller.signal.aborted || isAbort(cause)) return;
        const status = cause instanceof RlmApiError ? cause.status : 0;
        if (status === 401) {
          setError(text(cause));
          if (active.status === "submitting") {
            addNotice("Update the API token, then retry this request.");
          }
          onAuthRequired();
          return;
        }
        if (status === 503 && active.status === "submitting") {
          addNotice(
            "API_TOKEN is not configured on the Worker. Configure it, then retry."
          );
          return;
        }
        if (status === 404 && active.status === "recovering" && ++missing < 3) {
          return schedule(1_000);
        }
        if (status >= 400 && status < 500 && status !== 503) {
          return fail(
            `${active.status === "submitting" ? "" : "Unable to resume the durable request: "}${text(cause)}`
          );
        }
        if (active.status === "submitting") {
          save({
            ...active,
            status: "recovering",
            notice: `Admission outcome is unknown: ${text(cause)}`
          });
          return;
        }
        setError(text(cause));
        schedule(status === 503 ? 5_000 : 2_500);
      }
    };

    void run();
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [api, onAuthRequired, retry, save, turn?.requestId, turn?.status]);

  const submit = useCallback(
    (task: string, context: string) => {
      if (!api) return (onAuthRequired(), false);
      if (turnRef.current && turnRef.current.status !== "failed") return false;
      save({
        status: "submitting",
        requestId: crypto.randomUUID(),
        inputId: "",
        task: task.slice(0, PREVIEW_CHARS),
        payload: { task, context }
      });
      setError(null);
      return true;
    },
    [api, onAuthRequired, save]
  );

  return {
    history,
    active: turn?.status === "failed" ? null : turn,
    failed: turn?.status === "failed" ? turn : null,
    error,
    loading,
    submit,
    retryAdmission: () => {
      const current = turnRef.current;
      if (current && current.status !== "failed" && current.payload) {
        save({ ...current, status: "submitting", notice: undefined });
      }
      setRetry((value) => value + 1);
    },
    dismissError: () => setError(null)
  };
}
