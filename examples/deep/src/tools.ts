import { defineTool } from "agents/deep";
import * as z from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getCustomStatTimeseriesText, getCustomTopNText } from "./analytics";

const validDimension = (d: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(d);

export const GetTopNTextParams = z
  .object({
    zoneTag: z.string().describe("Zone tag for Cloudflare Analytics."),
    dimension: z
      .string()
      .regex(/^[A-Za-z0-9_]+$/)
      .describe(
        "Dimension name (alphanumeric/underscore). Example: clientIP, clientCountryName, edgeResponseStatus, clientASN, host, path, userAgent."
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(15)
      .describe("How many rows to return (1-50)."),
    startISO: z
      .string()
      .nullable()
      .optional()
      .describe("Optional start override (ISO8601)."),
    endISO: z
      .string()
      .nullable()
      .optional()
      .describe("Optional end override (ISO8601)."),
    andFilters: z
      .array(z.record(z.any()))
      .nullable()
      .optional()
      .describe(
        "Optional array of AND filter objects to narrow the query. " +
          "Each object is one filter condition on a valid analytics field " +
          "(e.g., [{ edgeResponseStatus: 403 }] or [{ clientCountryName: 'US' }]). "
      ),
    maxRows: z
      .number()
      .int()
      .min(1)
      .max(50)
      .nullable()
      .optional()
      .describe("Optional cap on shown rows (defaults to limit).")
  })
  .strict();

export type GetTopNTextArgs = z.infer<typeof GetTopNTextParams>;

export const getTopNTextTool = defineTool(
  {
    name: "get_topn_text",
    description:
      "Return a formatted Top-N table from Cloudflare Analytics for a chosen dimension (e.g., clientIP, clientCountryName, edgeResponseStatus, userAgent, clientASN, host, path, method). Use this to pivot quickly.",
    parameters: zodToJsonSchema(GetTopNTextParams)
  },
  async (p: GetTopNTextArgs, ctx) => {
    const start = ctx.agent.store.kv.get<number>("current_window.start");
    const end = ctx.agent.store.kv.get<number>("current_window.end");
    const { dimension, limit, startISO, endISO, maxRows, zoneTag, andFilters } =
      p;
    if (!validDimension(dimension))
      throw new Error(`Invalid dimension: ${dimension}`);
    const s = startISO ? new Date(startISO) : new Date(start!);
    const e = endISO ? new Date(endISO) : new Date(end!);

    const apiToken = ctx.env.CF_API_TOKEN;
    return await getCustomTopNText({
      apiToken,
      zoneTag,
      start: s,
      end: e,
      dimension,
      limit: typeof limit === "number" ? limit : 15,
      andFilters: [{ requestSource: "eyeball" }, ...(andFilters ?? [])],
      maxRows: typeof maxRows === "number" ? maxRows : undefined
    });
  }
);

export const GetTimeseriesTextParams = z
  .object({
    zoneTag: z.string().describe("Zone tag for Cloudflare Analytics."),
    startISO: z
      .string()
      .nullable()
      .optional()
      .describe("Optional start override (ISO8601)."),
    endISO: z
      .string()
      .nullable()
      .optional()
      .describe("Optional end override (ISO8601)."),
    prevStartISO: z
      .string()
      .nullable()
      .optional()
      .describe("Optional previous window start (ISO8601)."),
    prevEndISO: z
      .string()
      .nullable()
      .optional()
      .describe("Optional previous window end (ISO8601)."),
    limitPoints: z
      .number()
      .int()
      .min(10)
      .max(5000)
      .default(500)
      .describe("Max points in formatted output."),
    andFilters: z
      .array(z.record(z.any()))
      .nullable()
      .optional()
      .describe(
        "Optional array of AND filter objects to narrow the query. " +
          "Each object is one filter condition on a valid analytics field " +
          "(e.g., [{ edgeResponseStatus: 403 }] or [{ clientCountryName: 'US' }]). "
      )
  })
  .strict();

export type GetTimeseriesTextArgs = z.infer<typeof GetTimeseriesTextParams>;

export const getTimeseriesTextTool = defineTool(
  {
    name: "get_timeseries_text",
    description:
      "Return a formatted timeseries (current vs previous window) for request counts from Cloudflare Analytics. Use this to confirm spikes, dips, or diurnal patterns.",
    parameters: zodToJsonSchema(GetTimeseriesTextParams)
  },
  async (p: GetTimeseriesTextArgs, ctx) => {
    const start = ctx.agent.store.kv.get<number>("current_window.start");
    const end = ctx.agent.store.kv.get<number>("current_window.end");
    const {
      startISO,
      endISO,
      prevStartISO,
      prevEndISO,
      limitPoints,
      zoneTag,
      andFilters
    } = p;
    const s = startISO ? new Date(startISO) : new Date(start!);
    const e = endISO ? new Date(endISO) : new Date(end!);
    const ps = prevStartISO ? new Date(prevStartISO) : new Date(start!);
    const pe = prevEndISO ? new Date(prevEndISO) : new Date(end!);

    const apiToken = ctx.env.CF_API_TOKEN;
    return await getCustomStatTimeseriesText({
      apiToken,
      zoneTag,
      start: s,
      end: e,
      prevStart: ps,
      prevEnd: pe,
      andFilters: [{ requestSource: "eyeball" }, ...(andFilters ?? [])],
      limitPoints: typeof limitPoints === "number" ? limitPoints : 500
    });
  }
);

export const SetTimeWindowParams = z
  .object({
    startISO: z
      .string()
      .nullable()
      .optional()
      .describe("Absolute start (ISO8601)."),
    endISO: z
      .string()
      .nullable()
      .optional()
      .describe("Absolute end (ISO8601)."),
    lookbackHours: z
      .number()
      .min(0.1)
      .max(24 * 30)
      .nullable()
      .optional()
      .describe(
        "Sets window to now - lookbackHours -> now (overrides start/end)."
      ),
    zoom: z
      .enum(["in", "out"])
      .optional()
      .nullable()
      .describe("Zoom at window center."),
    factor: z
      .number()
      .min(0.05)
      .max(20)
      .default(2)
      .nullable()
      .optional()
      .describe("Zoom multiplier (default 2).")
  })
  .strict();

export type SetTimeWindowArgs = z.infer<typeof SetTimeWindowParams>;

export const setTimeWindowTool = defineTool(
  {
    name: "set_time_window",
    description:
      "Adjust the active time window used by other tools. Supports absolute range, relative lookback hours, or zoom in/out around center.",
    parameters: zodToJsonSchema(SetTimeWindowParams)
  },
  async (p: SetTimeWindowArgs, ctx) => {
    const { startISO, endISO, lookbackHours, zoom, factor } = p;

    const describe = (s: Date, e: Date) =>
      `OK. Window is now ${s.toISOString()} → ${e.toISOString()} (duration ${(e.getTime() - s.getTime()) / 3600000}h).`;

    if (typeof lookbackHours === "number" && lookbackHours > 0) {
      const end = new Date();
      const start = new Date(end.getTime() - lookbackHours * 3600000);
      ctx.agent.store.kv.put("current_window.start", start.getTime());
      ctx.agent.store.kv.put("current_window.end", end.getTime());
      return describe(start, end);
    }

    if (startISO && endISO) {
      const s = new Date(startISO);
      const e = new Date(endISO);
      if (
        !(s instanceof Date) ||
        !(e instanceof Date) ||
        isNaN(+s) ||
        isNaN(+e) ||
        s >= e
      ) {
        throw new Error("Invalid absolute start/end.");
      }
      ctx.agent.store.kv.put("current_window.start", s.getTime());
      ctx.agent.store.kv.put("current_window.end", e.getTime());
      return describe(s, e);
    }

    if (zoom === "in" || zoom === "out") {
      let start = new Date(
        ctx.agent.store.kv.get<number>("current_window.start")!
      );
      let end = new Date(ctx.agent.store.kv.get<number>("current_window.end")!);
      const dur = end.getTime() - start.getTime();
      const k = typeof factor === "number" && factor > 0 ? factor : 2;
      const center = start.getTime() + dur / 2;
      const newDur =
        zoom === "in"
          ? Math.max(dur / k, 60_000)
          : Math.min(dur * k, 1000 * 3600 * 24 * 90);
      start = new Date(center - newDur / 2);
      end = new Date(center + newDur / 2);
      return describe(start, end);
    }

    return "No changes made (provide lookbackHours, or both startISO/endISO, or zoom).";
  }
);

export const GetCurrentWindowParams = z.object({}).strict();
export type GetCurrentWindowArgs = z.infer<typeof GetCurrentWindowParams>;

export const getCurrentWindowTool = defineTool(
  {
    name: "get_current_window",
    description: "Return the current time window used by other tools."
  },
  async (_: GetCurrentWindowArgs, ctx) => {
    const start = new Date(
      ctx.agent.store.kv.get<number>("current_window.start")!
    );
    const end = new Date(ctx.agent.store.kv.get<number>("current_window.end")!);
    return `Current window: ${start.toISOString()} → ${end.toISOString()} (duration ${(end.getTime() - start.getTime()) / 3600000}h).`;
  }
);
