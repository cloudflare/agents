import { afterAll } from "vitest";

// When vitest-pool-workers transitions between test files (with singleWorker: true),
// it invalidates Durable Objects from the previous module. If a DO is still processing
// a WebSocket close handler (waking from hibernation → webSocketClose → onClose),
// the invalidation produces noisy workerd "uncaught exception" logs.
//
// This global afterAll gives DOs a moment to finish their close handlers before
// the module is invalidated. Applied to every test file via vitest setupFiles.
afterAll(() => new Promise((resolve) => setTimeout(resolve, 100)));
