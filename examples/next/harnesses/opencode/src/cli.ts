const AGENT_PREFIX = /^\/agents\/[^/]+\/[^/]+/;

export function openCodeRequest(request: Request): Request {
  const url = new URL(request.url);
  url.pathname = url.pathname.replace(AGENT_PREFIX, "") || "/";
  return new Request(url, request);
}
