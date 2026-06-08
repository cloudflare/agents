import { data, useLoaderData } from "react-router";
import type { AppLoadContext } from "react-router";

export async function loader({ context }: { context: AppLoadContext }) {
  return data({
    hasEnv: Boolean(context.cloudflare.env),
    hasCtx: Boolean(context.cloudflare.ctx)
  });
}

export default function Host() {
  const loaderData = useLoaderData<typeof loader>();

  return (
    <main>
      React Router host: {loaderData.hasEnv ? "env" : "missing-env"} /{" "}
      {loaderData.hasCtx ? "ctx" : "missing-ctx"}
    </main>
  );
}
