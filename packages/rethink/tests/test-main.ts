export * from "../src/index";
export { GreetingDurableObject } from "./cases/greet.do";

export default {
  fetch() {
    return new Response("Not found", { status: 404 });
  }
};
