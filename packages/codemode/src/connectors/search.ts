/**
 * Executor-style ranked search over connector methods and saved snippets.
 *
 * Normalizes camelCase, snake_case, dots, and path separators into tokens,
 * scores fields by weight, requires token coverage, and sorts by score.
 */
import type { ConnectorDescription } from "./types";
import type { SearchResult, SearchOutput } from "./types";
import type { Snippet } from "../snippet";

const SEARCH_RESULT_LIMIT = 50;

const FIELD_WEIGHTS = {
  path: 12,
  connector: 8,
  method: 10,
  description: 5
} as const;

function normalizeSearchText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./:-]+/g, " ")
    .toLowerCase()
    .trim();
}

function tokenize(value: string): string[] {
  return normalizeSearchText(value)
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

type PreparedField = { raw: string; tokens: string[] };

function prepareField(value?: string): PreparedField {
  return {
    raw: normalizeSearchText(value ?? ""),
    tokens: tokenize(value ?? "")
  };
}

function scoreField(
  query: string,
  queryTokens: string[],
  field: PreparedField,
  weight: number
): { score: number; matchedTokens: Set<string>; exactPhrase: boolean } {
  if (field.raw.length === 0)
    return { score: 0, matchedTokens: new Set(), exactPhrase: false };

  let score = 0;
  const matchedTokens = new Set<string>();
  const exactPhrase = query.length > 0 && field.raw.includes(query);

  if (query.length > 0) {
    if (field.raw === query) score += weight * 14;
    else if (field.raw.startsWith(query)) score += weight * 9;
    else if (exactPhrase) score += weight * 6;
  }

  for (const token of queryTokens) {
    if (field.tokens.includes(token)) {
      score += weight * 4;
      matchedTokens.add(token);
    } else if (
      field.tokens.some((c) => c.startsWith(token) || token.startsWith(c))
    ) {
      score += weight * 2;
      matchedTokens.add(token);
    } else if (field.raw.includes(token)) {
      score += weight;
      matchedTokens.add(token);
    }
  }

  return { score, matchedTokens, exactPhrase };
}

type SearchableItem = {
  path: string;
  connector: string;
  method: string;
  description?: string;
  kind: "method" | "snippet";
};

function scoreMatch(item: SearchableItem, query: string): SearchResult | null {
  const normalizedQuery = normalizeSearchText(query);
  const queryTokens = tokenize(query);
  if (normalizedQuery.length === 0 || queryTokens.length === 0) return null;

  const fields = [
    scoreField(
      normalizedQuery,
      queryTokens,
      prepareField(item.path),
      FIELD_WEIGHTS.path
    ),
    scoreField(
      normalizedQuery,
      queryTokens,
      prepareField(item.connector),
      FIELD_WEIGHTS.connector
    ),
    scoreField(
      normalizedQuery,
      queryTokens,
      prepareField(item.method),
      FIELD_WEIGHTS.method
    ),
    scoreField(
      normalizedQuery,
      queryTokens,
      prepareField(item.description),
      FIELD_WEIGHTS.description
    )
  ];

  const matchedTokens = new Set<string>();
  let score = 0;
  let exactPhrase = false;

  for (const field of fields) {
    score += field.score;
    exactPhrase ||= field.exactPhrase;
    for (const t of field.matchedTokens) matchedTokens.add(t);
  }

  if (matchedTokens.size === 0) return null;

  const coverage = matchedTokens.size / queryTokens.length;
  const minimumCoverage = queryTokens.length <= 2 ? 1 : 0.6;
  if (coverage < minimumCoverage && !exactPhrase) return null;

  if (coverage === 1) score += 25;
  else score += Math.round(coverage * 10);

  const pathTokens = tokenize(item.path);
  const methodTokens = tokenize(item.method);
  if (pathTokens[0] === queryTokens[0] || methodTokens[0] === queryTokens[0])
    score += 8;

  if (
    normalizeSearchText(item.path) === normalizedQuery ||
    normalizeSearchText(item.method) === normalizedQuery
  )
    score += 20;

  return {
    path: item.path,
    connector: item.connector,
    method: item.method,
    description: item.description,
    kind: item.kind,
    score
  };
}

export function searchConnectors(
  query: string,
  descriptions: ConnectorDescription[],
  snippets?: Snippet[]
): SearchOutput {
  const items: SearchableItem[] = [];

  for (const desc of descriptions) {
    for (const [methodName, descriptor] of Object.entries(desc.descriptors)) {
      items.push({
        path: `${desc.name}.${methodName}`,
        connector: desc.name,
        method: methodName,
        description: descriptor?.description,
        kind: "method"
      });
    }
  }

  if (snippets) {
    for (const snippet of snippets) {
      items.push({
        path: snippet.name,
        connector: "snippet",
        method: snippet.name,
        description: snippet.description,
        kind: "snippet"
      });
    }
  }

  const ranked = items
    .map((item) => scoreMatch(item, query))
    .filter((r): r is SearchResult => r !== null)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const total = ranked.length;
  const results = ranked.slice(0, SEARCH_RESULT_LIMIT);

  return { results, total, truncated: total > SEARCH_RESULT_LIMIT };
}
