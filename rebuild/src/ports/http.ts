/** Outbound fetch abstraction used by the fetch tool. */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    redirect?: "manual";
    signal?: AbortSignal;
  }
) => Promise<{
  status: number;
  headers: Map<string, string>;
  url: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;
