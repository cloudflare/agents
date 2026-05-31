import { data, useLoaderData } from "react-router";

export async function loader() {
  return data({ message: "React Router home" });
}

export default function Home() {
  const loaderData = useLoaderData<typeof loader>();

  return <main>{loaderData.message}</main>;
}
