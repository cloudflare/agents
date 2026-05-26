import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("host", "routes/host.tsx")
] satisfies RouteConfig;
