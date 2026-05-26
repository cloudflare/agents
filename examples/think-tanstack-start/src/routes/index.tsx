import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  loader: () => ({ message: "TanStack Start home" }),
  component: Home
});

function Home() {
  const loaderData = Route.useLoaderData();

  return <main>{loaderData.message}</main>;
}
