import { data, useLoaderData, type RouterContextProvider } from "react-router";
import { cloudflareContext } from "../context";

export async function loader({ context }: { context: RouterContextProvider }) {
  const cloudflare = context.get(cloudflareContext);

  return data({
    hasEnv: Boolean(cloudflare.env),
    hasCtx: Boolean(cloudflare.ctx)
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
