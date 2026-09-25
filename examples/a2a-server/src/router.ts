import { createA2AWorker } from "./runtime/index";
import { coordinatorOptions, specialistOptions } from "./runtime";

const coordinator = createA2AWorker(coordinatorOptions);
const specialist = createA2AWorker(specialistOptions);

/** Routes both public endpoints and the coordinator's same-Worker HTTP calls. */
export async function handleWorkerRequest(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const route = routeForPath(url.pathname);
  if (!route) {
    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({
        coordinator: {
          agentCard: "/coordinator/.well-known/agent-card.json",
          a2a: "/coordinator/a2a"
        },
        specialist: {
          agentCard: "/specialist/.well-known/agent-card.json",
          a2a: "/specialist/a2a"
        }
      });
    }
    return new Response("Not found", { status: 404 });
  }

  url.pathname = url.pathname.slice(route.prefix.length) || "/";
  const routed = new Request(url, request);
  return route.worker.fetch(routed, env);
}

function routeForPath(pathname: string) {
  if (pathname === "/coordinator" || pathname.startsWith("/coordinator/")) {
    return { prefix: "/coordinator", worker: coordinator };
  }
  if (pathname === "/specialist" || pathname.startsWith("/specialist/")) {
    return { prefix: "/specialist", worker: specialist };
  }
  return undefined;
}

export default {
  fetch: handleWorkerRequest
} satisfies ExportedHandler<Env>;
