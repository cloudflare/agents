/**
 * Test entry point for the worker-bundler test suite.
 *
 * Re-exports the full public API from the real index so that all existing
 * tests continue to work unmodified, and additionally exports Durable Object
 * classes that are only needed as test fixtures (e.g. to obtain a real
 * DurableObjectStorage instance via runInDurableObject).
 */
export * from "../index";

import { DurableObject } from "cloudflare:workers";

/**
 * Minimal Durable Object used as a test fixture for DurableObjectKVFileSystem
 * tests. It has no business logic of its own; its sole purpose is to provide
 * a real DurableObjectStorage instance via runInDurableObject().
 */
export class FsTestDO extends DurableObject {}
