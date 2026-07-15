/**
 * Minimal URL router for hosted Durable Object agents.
 *
 * It preserves the incoming URL/query and only stamps the out-of-band agent
 * name header that the DO shell needs because workerd does not expose
 * `ctx.id.name` inside the object.
 */
export async function routeAgentRequest(
  request: Request,
  env: Record<string, unknown>,
  options: { prefix?: string } = {}
): Promise<Response | undefined> {
  const prefix = options.prefix ?? "agents";
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] !== prefix) return undefined;

  const bindingSegment = segments[1];
  const nameSegment = segments[2];
  if (!bindingSegment || !nameSegment) return undefined;

  const match = findNamespace(env, bindingSegment);
  // A request under the agent prefix naming a binding that doesn't exist is
  // a CLIENT error (original semantics), not a fall-through to other routes.
  if (!match) return new Response(`Unknown agent binding: ${bindingSegment}`, { status: 400 });

  const name = decodeURIComponent(nameSegment);
  const id = match.namespace.idFromName(name);
  const stub = match.namespace.get(id);
  const headers = new Headers(request.headers);
  headers.set("x-agent-name", name);

  return stub.fetch(new Request(request, { headers }));
}

export async function getAgentByName(
  namespace: DurableObjectNamespace,
  name: string
): Promise<DurableObjectStub> {
  const stub = namespace.get(namespace.idFromName(name));
  await (stub as DurableObjectStub & {
    __init(init: { name: string }): Promise<void>;
  }).__init({ name });
  return stub;
}

function findNamespace(
  env: Record<string, unknown>,
  segment: string
): { namespace: DurableObjectNamespace } | undefined {
  const normalized = segment.toLowerCase();
  for (const [binding, value] of Object.entries(env)) {
    if (!isDurableObjectNamespace(value)) continue;
    if (
      binding.toLowerCase() === normalized ||
      toKebabCase(binding).toLowerCase() === normalized
    ) {
      return { namespace: value };
    }
  }
  return undefined;
}

function isDurableObjectNamespace(
  value: unknown
): value is DurableObjectNamespace {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    idFromName?: unknown;
    get?: unknown;
  };
  return (
    typeof candidate.idFromName === "function" &&
    typeof candidate.get === "function"
  );
}

function toKebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    // Acronym boundaries: "E2EAgent" -> "E2E-Agent", matching the original
    // slugger's parity rules (found by the ported e2e suite: without this,
    // ThinkStallRecoveryE2EAgent slugged to "...e2-eagent" and never routed).
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase();
}
