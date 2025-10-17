// TODO: remove this

import {
  CF_GQL_ENDPOINT,
  GET_CUSTOM_STAT,
  GET_CUSTOM_TOPN_TEMPLATE
} from "./constants";

type TopNRow = { metric: string; count: number };
type CFAndFilter = Record<string, any>;

/*
 * Helpers
 */

// Fromatting for dates
function iso(dt: Date): string {
  // Ensure UTC `YYYY-MM-DDTHH:MM:SSZ`
  const z = new Date(dt.getTime());
  const s = z.toISOString();
  return s.replace(/\.\d{3}Z$/, "Z");
}

// Used for retries
async function sleep(seconds: number) {
  await new Promise((r) => setTimeout(r, seconds * 1000));
}

// GraphQL filter builder for a time range + custom filters
function buildFilter(opts: {
  start: Date;
  end: Date;
  andFilters?: CFAndFilter[] | undefined;
  extra?: Record<string, any> | undefined;
}) {
  const flt: Record<string, any> = {
    datetime_geq: iso(opts.start),
    datetime_lt: iso(opts.end)
  };
  if (opts.andFilters && opts.andFilters.length) flt.AND = opts.andFilters;
  if (opts.extra) Object.assign(flt, opts.extra);
  return flt;
}

// Call GraphQL API with retries
async function executeGql<T = any>(args: {
  query: string;
  variables: Record<string, any>;
  apiToken: string;
  retries?: number;
  backoffBase?: number;
}): Promise<T> {
  const { query, variables, apiToken, retries = 3, backoffBase = 0.5 } = args;
  const payload = JSON.stringify({ query, variables });

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(CF_GQL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json"
      },
      body: payload
    });

    if (res.status === 200) {
      const data = await res.json<any>();
      if (data?.errors?.length) {
        throw new Error(`GraphQL error: ${JSON.stringify(data.errors[0])}`);
      }
      return data;
    }

    if ([429, 500, 502, 503, 504].includes(res.status) && attempt < retries) {
      const retryAfter = res.headers.get("Retry-After");
      const delay = retryAfter
        ? parseFloat(retryAfter)
        : backoffBase * 2 ** attempt;
      await sleep(isFinite(delay) ? delay : backoffBase);
      continue;
    }

    let detail: any;
    try {
      detail = await res.json();
    } catch {
      detail = await res.text();
    }
    throw new Error(
      `GraphQL HTTP ${res.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`
    );
  }

  // Should never get here
  throw new Error("Unreachable");
}

function injectDimension(q: string, dimension: string): string {
  // Basic safety: allow alphanumerics and underscore only for the field name
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dimension)) {
    throw new Error(`Invalid dimension: ${dimension}`);
  }
  return q.replace("DIMENSION_PLACEHOLDER", dimension);
}

// -------------------------
// Public functions
// -------------------------

function fmtNumber(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

function simplifyGrowth(current: number, previous: number) {
  const delta = current - previous;
  const pct = previous ? (delta / previous) * 100 : current ? 100 : 0;
  return { delta, pct };
}

export function topnToText(
  rows: TopNRow[],
  total?: number,
  maxRows: number = 15
): string {
  const lines: string[] = [];
  if (typeof total === "number") lines.push(`Total: ${fmtNumber(total)}`);
  lines.push(`Top ${Math.min(maxRows, rows.length)}:`);
  for (let i = 0; i < Math.min(maxRows, rows.length); i++) {
    const r = rows[i];
    const cnt = r?.count ?? 0;
    const metric = String(r?.metric ?? "");
    const share = total ? ` (${((cnt / total) * 100).toFixed(2)}%)` : "";
    lines.push(`${i + 1}) ${metric} — ${fmtNumber(cnt)}${share}`);
  }
  return lines.join("\n");
}

export function timeseriesToText(
  total: number,
  previous: number,
  sparkline: { ts: string; count: number }[],
  limitPoints: number = 48
): string {
  const chg = simplifyGrowth(total, previous);
  const lines: string[] = [
    `Total (current): ${fmtNumber(total)}`,
    `Total (previous): ${fmtNumber(previous)}`,
    `Change: ${chg.delta >= 0 ? "+" : ""}${fmtNumber(chg.delta)} (${chg.pct.toFixed(2)}%)`,
    "Trend (hourly):"
  ];
  const start = Math.max(0, sparkline.length - limitPoints);
  for (let i = start; i < sparkline.length; i++) {
    const dp = sparkline[i];
    lines.push(`${dp.ts} — ${fmtNumber(dp.count)}`);
  }
  return lines.join("\n");
}

// --- Core queries that feed the string formatters ---

export async function getCustomTopN(args: {
  apiToken: string;
  zoneTag: string;
  start: Date;
  end: Date;
  dimension?: string;
  limit?: number;
  andFilters?: CFAndFilter[];
  extraFilterFields?: Record<string, any>;
}): Promise<{ total: number; topN: TopNRow[] }> {
  const {
    apiToken,
    zoneTag,
    start,
    end,
    dimension = "clientIP",
    limit = 15,
    andFilters,
    extraFilterFields
  } = args;

  const filter = buildFilter({
    start,
    end,
    andFilters,
    extra: extraFilterFields
  });
  const query = injectDimension(GET_CUSTOM_TOPN_TEMPLATE, dimension);

  const variables = {
    zoneTag,
    filter,
    limit: Number(limit)
  };

  const data = await executeGql<any>({ query, variables, apiToken });
  const scope = data?.data?.viewer?.scope?.[0] ?? {};

  const total = scope?.total?.[0]?.count ?? 0;
  const rows: TopNRow[] = [];
  for (const r of scope?.topN ?? []) {
    rows.push({ metric: r?.dimensions?.metric ?? "", count: r?.count ?? 0 });
  }
  return { total, topN: rows };
}

export async function getCustomStatTimeseries(args: {
  apiToken: string;
  zoneTag: string;
  start: Date;
  end: Date;
  prevStart?: Date;
  prevEnd?: Date;
  andFilters?: CFAndFilter[];
  extraFilterFields?: Record<string, any>;
}): Promise<{
  total: number;
  previous: number;
  sparkline: { ts: string; count: number }[];
}> {
  const {
    apiToken,
    zoneTag,
    start,
    end,
    prevStart,
    prevEnd,
    andFilters,
    extraFilterFields
  } = args;

  // Compute previous window if not provided
  let pStart = prevStart;
  let pEnd = prevEnd;
  if (!pStart || !pEnd) {
    const durationMs = end.getTime() - start.getTime();
    pEnd = new Date(start.getTime());
    pStart = new Date(start.getTime() - durationMs);
  }

  const currFilter = buildFilter({
    start,
    end,
    andFilters,
    extra: extraFilterFields
  });
  const prevFilter = buildFilter({
    start: pStart!,
    end: pEnd!,
    andFilters,
    extra: extraFilterFields
  });

  const variables = { zoneTag, filter: currFilter, prevFilter };
  const data = await executeGql<any>({
    query: GET_CUSTOM_STAT,
    variables,
    apiToken
  });

  const scope = data?.data?.viewer?.scope?.[0] ?? {};
  const total = scope?.total?.[0]?.count ?? 0;
  const previous = scope?.previously?.[0]?.count ?? 0;

  const sparkline: { ts: string; count: number }[] = [];
  for (const r of scope?.sparkline ?? []) {
    sparkline.push({ ts: r?.dimensions?.ts, count: r?.count ?? 0 });
  }

  return { total, previous, sparkline };
}

async function getCustomTopNText(args: {
  apiToken: string;
  zoneTag: string;
  start: Date;
  end: Date;
  dimension?: string;
  limit?: number;
  andFilters?: CFAndFilter[];
  extraFilterFields?: Record<string, any>;
  maxRows?: number;
}): Promise<string> {
  const apiToken = args.apiToken;
  const { total, topN } = await getCustomTopN({ ...args, apiToken });
  return topnToText(topN, total, args.maxRows ?? args.limit ?? 15);
}

async function getCustomStatTimeseriesText(args: {
  apiToken: string;
  zoneTag: string;
  accountTag?: string;
  start: Date;
  end: Date;
  prevStart?: Date;
  prevEnd?: Date;
  andFilters?: CFAndFilter[];
  extraFilterFields?: Record<string, any>;
  limitPoints?: number;
}): Promise<string> {
  const apiToken = args.apiToken;
  const res = await getCustomStatTimeseries({ ...args, apiToken });
  return timeseriesToText(
    res.total,
    res.previous,
    res.sparkline,
    args.limitPoints ?? 1000
  );
}

export { getCustomTopNText, getCustomStatTimeseriesText, type CFAndFilter };
