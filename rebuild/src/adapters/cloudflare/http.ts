import type { FetchLike } from "../../ports/http.js";

async function toFetchLikeResponse(response: Response): ReturnType<FetchLike> {
  return {
    status: response.status,
    headers: new Map(response.headers.entries()),
    url: response.url,
    arrayBuffer: () => response.arrayBuffer()
  };
}

function wrapFetch(fetchImpl: () => typeof fetch): FetchLike {
  return async (url, init) =>
    toFetchLikeResponse(
      await fetchImpl()(url, {
        method: init?.method,
        headers: init?.headers,
        redirect: init?.redirect,
        signal: init?.signal
      })
    );
}

export const workersFetch: FetchLike = wrapFetch(() => globalThis.fetch);

export function serviceBindingFetch(binding: {
  fetch: typeof fetch;
}): FetchLike {
  const bindingFetch = binding.fetch.bind(binding);
  return wrapFetch(() => bindingFetch);
}
