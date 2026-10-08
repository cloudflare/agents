import type { UIDataTypes, UIMessage } from "ai";
import type {
  WebFetchFormat,
  WebFetchPage,
  WebFetchToolInput,
  WebFetchToolOutput,
  WebFetchVia
} from "agents/webfetch";
import type { WebSearchToolInput, WebSearchToolOutput } from "agents/websearch";

/** The Workers AI model the chat agent runs on. */
export const MODEL = "@cf/moonshotai/kimi-k2.7-code";

export const MIN_PAGE_CHARS = 5_000;
export const MAX_PAGE_CHARS = 50_000;

/**
 * The fetch settings you can change from the UI. They live in the agent's
 * state, so they persist and stay in sync across tabs. The chat and the URL
 * Lab use them; the corpus always runs with the defaults so its
 * expectations stay stable.
 */
export interface LabSettings {
  /** Characters of a page the model reads per `web_fetch` call. */
  pageChars: number;
  /** The format used when the model (or URL Lab) doesn't pick one. */
  format: WebFetchFormat;
  /** Allow `localhost`, private IPs, and other local-only hosts. */
  allowPrivateHosts: boolean;
}

export const DEFAULT_SETTINGS: LabSettings = {
  pageChars: 20_000,
  format: "auto",
  allowPrivateHosts: false
};

export function isWebFetchFormat(value: unknown): value is WebFetchFormat {
  return value === "auto" || value === "raw";
}

export function isLabSettings(value: unknown): value is LabSettings {
  if (typeof value !== "object" || value === null) return false;
  const { pageChars, format, allowPrivateHosts } = value as Record<
    string,
    unknown
  >;
  return (
    typeof pageChars === "number" &&
    Number.isInteger(pageChars) &&
    pageChars >= MIN_PAGE_CHARS &&
    pageChars <= MAX_PAGE_CHARS &&
    isWebFetchFormat(format) &&
    typeof allowPrivateHosts === "boolean"
  );
}

// ── URL Lab ─────────────────────────────────────────────────────────

/** What the URL Lab sends to the agent's `fetchUrl` method. */
export interface FetchUrlArgs {
  url: string;
  format?: WebFetchFormat;
  offset?: number;
}

/** What `fetchUrl` returns: the whole page, or the error's details. */
export type FetchUrlResult =
  | {
      ok: true;
      page: WebFetchPage;
      /** The requested window's start. */
      offset: number;
      /** The text the model would read for this window. */
      text: string;
      /** The window size used, so the client can page. */
      pageChars: number;
      ms: number;
    }
  | {
      ok: false;
      code: string;
      message: string;
      status: number;
      retryable: boolean;
      /** The URL the failure is about, when known (e.g. a redirect hop). */
      url?: string;
      contentType?: string;
      ms: number;
    };

// ── Corpus ──────────────────────────────────────────────────────────

/** What one corpus run observed. */
export interface CorpusActual {
  status?: number;
  via?: WebFetchVia;
  chars?: number;
  finalUrl?: string;
  contentType?: string;
  redirects?: string[];
  title?: string;
  bytes?: number;
  /** The response headers `web_fetch` keeps. */
  headers?: Record<string, string>;
  /** Set when the fetch failed. */
  errorCode?: string;
  errorMessage?: string;
}

/** One corpus entry's result, streamed to the client as it finishes. */
export interface CorpusResult {
  id: string;
  pass: boolean;
  /** Why it failed; empty when it passed. */
  failures: string[];
  actual: CorpusActual;
  /** The first characters of the content, for the detail cell. */
  preview?: string;
  ms: number;
}

/** The final chunk of a corpus run. */
export interface CorpusSummary {
  total: number;
  passed: number;
  failed: number;
  ms: number;
}

// ── Chat ────────────────────────────────────────────────────────────

/** Chat messages with both tools' input and output typed. */
export type LabMessage = UIMessage<
  unknown,
  UIDataTypes,
  {
    web_search: { input: WebSearchToolInput; output: WebSearchToolOutput };
    web_fetch: { input: WebFetchToolInput; output: WebFetchToolOutput };
  }
>;
