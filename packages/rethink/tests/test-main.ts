export * from "../src/index";
export { GreetingDurableObject } from "./cases/greet.do";
export { TracerBulletDurableObject } from "./cases/tracer-bullet.do";

export default {
  fetch() {
    return new Response("Not found", { status: 404 });
  }
};
