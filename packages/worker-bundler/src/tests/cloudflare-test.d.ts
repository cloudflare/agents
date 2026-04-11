declare namespace Cloudflare {
  interface Env {
    LOADER: WorkerLoader;
    FS_TEST: DurableObjectNamespace<import("./test-main").FsTestDO>;
  }
}
