import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

const getHostContext = createServerFn({ method: "GET" }).handler(() => ({
  hasEnv: Boolean(env),
  hasHostBinding: Boolean(env.ThinkAgent_Host)
}));

export const Route = createFileRoute("/host")({
  loader: () => getHostContext(),
  component: Host
});

function Host() {
  const loaderData = Route.useLoaderData();

  return (
    <main>
      TanStack Start host: {loaderData.hasEnv ? "env" : "missing-env"} /{" "}
      {loaderData.hasHostBinding ? "binding" : "missing-binding"}
    </main>
  );
}
