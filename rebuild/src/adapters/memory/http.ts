import { NotFoundError } from "../../kernel/errors.js";
import type { FetchLike } from "../../ports/http.js";

export interface MemoryHttpResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer | Uint8Array;
  url?: string;
}

type RouteInit = Parameters<FetchLike>[1];
type Route =
  | MemoryHttpResponse
  | MemoryHttpResponse[]
  | ((url: string, init?: RouteInit) => MemoryHttpResponse);

function bodyToArrayBuffer(body: MemoryHttpResponse["body"]): ArrayBuffer {
  if (body === undefined) return new ArrayBuffer(0);
  if (typeof body === "string") return new TextEncoder().encode(body).buffer as ArrayBuffer;
  if (body instanceof Uint8Array) return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  return body;
}

/** Route-table fake for outbound HTTP: scripted responses/redirects keyed by exact URL. */
export function createMemoryFetch(routes: Record<string, Route>): FetchLike {
  const callCounts = new Map<string, number>();

  return async (url: string, init?: RouteInit) => {
    const route = routes[url];
    if (route === undefined) {
      throw new NotFoundError(`No scripted route for ${url}`);
    }

    let response: MemoryHttpResponse;
    if (typeof route === "function") {
      response = route(url, init);
    } else if (Array.isArray(route)) {
      const count = callCounts.get(url) ?? 0;
      callCounts.set(url, count + 1);
      const index = Math.min(count, route.length - 1);
      const picked = route[index];
      if (!picked) throw new NotFoundError(`No scripted route for ${url}`);
      response = picked;
    } else {
      response = route;
    }

    const headers = new Map<string, string>(Object.entries(response.headers ?? {}));

    return {
      status: response.status,
      headers,
      url: response.url ?? url,
      async arrayBuffer(): Promise<ArrayBuffer> {
        return bodyToArrayBuffer(response.body);
      },
    };
  };
}
