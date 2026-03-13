import { describe, expect, it } from "vitest";
import { Bash, type BashLogger } from "./Shell";

// Helper to create a mock clock for testing sleep
function createMockClock() {
  const pendingSleeps: Array<{
    resolve: () => void;
    triggerAt: number;
  }> = [];
  let currentTime = 0;

  return {
    sleep: (ms: number): Promise<void> => {
      return new Promise((resolve) => {
        pendingSleeps.push({ resolve, triggerAt: currentTime + ms });
      });
    },
    advance: (ms: number): void => {
      currentTime += ms;
      // Wake up any sleeps that should complete
      for (let i = pendingSleeps.length - 1; i >= 0; i--) {
        if (pendingSleeps[i].triggerAt <= currentTime) {
          pendingSleeps[i].resolve();
          pendingSleeps.splice(i, 1);
        }
      }
    },
    get time(): number {
      return currentTime;
    },
    get pendingCount(): number {
      return pendingSleeps.length;
    }
  };
}

// Helper to wait for a condition to be true, with polling
// More reliable than a fixed number of ticks
async function waitFor(
  condition: () => boolean,
  timeoutMs = 1000
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe("exec options", () => {
  describe("per-exec env", () => {
    it("should use env vars for single execution", async () => {
      const env = new Bash();
      const result = await env.exec("echo $FOO", { env: { FOO: "bar" } });
      expect(result.stdout).toBe("bar\n");
    });

    it("should not persist env vars after execution", async () => {
      const env = new Bash();
      await env.exec("echo $FOO", { env: { FOO: "bar" } });
      const result = await env.exec("echo $FOO");
      expect(result.stdout).toBe("\n"); // FOO should not be set
    });

    it("should merge with existing env vars", async () => {
      const env = new Bash({ env: { EXISTING: "value" } });
      const result = await env.exec("echo $EXISTING $NEW", {
        env: { NEW: "added" }
      });
      expect(result.stdout).toBe("value added\n");
    });

    it("should override existing env vars temporarily", async () => {
      const env = new Bash({ env: { VAR: "original" } });

      // Override temporarily
      const result1 = await env.exec("echo $VAR", { env: { VAR: "override" } });
      expect(result1.stdout).toBe("override\n");

      // Original should be restored
      const result2 = await env.exec("echo $VAR");
      expect(result2.stdout).toBe("original\n");
    });

    it("should work with multiple env vars", async () => {
      const env = new Bash();
      const result = await env.exec("echo $A $B $C", {
        env: { A: "1", B: "2", C: "3" }
      });
      expect(result.stdout).toBe("1 2 3\n");
    });

    it("should handle env vars with special characters", async () => {
      const env = new Bash();
      const result = await env.exec('echo "$MSG"', {
        env: { MSG: "hello world" }
      });
      expect(result.stdout).toBe("hello world\n");
    });
  });

  describe("replaceEnv", () => {
    it("should start with empty environment when replaceEnv is true", async () => {
      const bash = new Bash({ env: { FOO: "bar", PATH: "/usr/bin:/bin" } });
      const result = await bash.exec("printenv FOO", {
        replaceEnv: true,
        env: {}
      });
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(1);
    });

    it("should apply provided env vars on top of empty environment", async () => {
      const bash = new Bash({ env: { FOO: "bar" } });
      const result = await bash.exec("printenv ONLY", {
        replaceEnv: true,
        env: { ONLY: "value" }
      });
      expect(result.stdout).toBe("value\n");
      expect(result.exitCode).toBe(0);
    });

    it("should not affect subsequent executions", async () => {
      const bash = new Bash({ env: { FOO: "bar" } });
      await bash.exec("echo x", { replaceEnv: true, env: { X: "1" } });
      const result = await bash.exec("printenv FOO");
      expect(result.stdout).toBe("bar\n");
    });

    it("replaceEnv false should merge like normal", async () => {
      const bash = new Bash({ env: { FOO: "bar" } });
      const result = await bash.exec("printenv FOO; printenv EXTRA", {
        replaceEnv: false,
        env: { EXTRA: "added" }
      });
      expect(result.stdout).toBe("bar\nadded\n");
    });
  });

  describe("per-exec cwd", () => {
    it("should use cwd for single execution", async () => {
      const env = new Bash({ files: { "/tmp/test/file.txt": "content" } });
      const result = await env.exec("pwd", { cwd: "/tmp/test" });
      expect(result.stdout).toBe("/tmp/test\n");
    });

    it("should not persist cwd after execution", async () => {
      const env = new Bash({
        files: { "/tmp/test/file.txt": "content" },
        cwd: "/"
      });
      await env.exec("pwd", { cwd: "/tmp/test" });
      const result = await env.exec("pwd");
      expect(result.stdout).toBe("/\n");
    });

    it("should resolve relative paths from per-exec cwd", async () => {
      const env = new Bash({
        files: { "/project/src/main.ts": "console.log('hi')" }
      });
      const result = await env.exec("cat main.ts", { cwd: "/project/src" });
      expect(result.stdout).toBe("console.log('hi')");
    });
  });

  describe("combined options", () => {
    it("should handle both env and cwd together", async () => {
      const env = new Bash({
        files: { "/app/config": "config file" },
        cwd: "/"
      });
      const result = await env.exec('echo "$PWD: $APP_ENV"', {
        cwd: "/app",
        env: { APP_ENV: "production" }
      });
      expect(result.stdout).toBe("/app: production\n");
    });

    it("should restore both env and cwd after execution", async () => {
      const env = new Bash({
        files: { "/app/config": "config" },
        cwd: "/",
        env: { MODE: "dev" }
      });

      await env.exec("echo $MODE", { cwd: "/app", env: { MODE: "prod" } });

      const cwdResult = await env.exec("pwd");
      expect(cwdResult.stdout).toBe("/\n");

      const envResult = await env.exec("echo $MODE");
      expect(envResult.stdout).toBe("dev\n");
    });
  });

  describe("error handling", () => {
    it("should restore state even on command error", async () => {
      const env = new Bash({ env: { VAR: "original" } });
      await env.exec("nonexistent_command", { env: { VAR: "temp" } });
      const result = await env.exec("echo $VAR");
      expect(result.stdout).toBe("original\n");
    });

    it("should restore state even on parse error", async () => {
      const env = new Bash({ env: { VAR: "original" } });
      await env.exec("echo ${", { env: { VAR: "temp" } });
      const result = await env.exec("echo $VAR");
      expect(result.stdout).toBe("original\n");
    });
  });

  describe("concurrent execution", () => {
    it("concurrent exec with different env options should be isolated", async () => {
      const env = new Bash({ env: { SHARED: "original" } });

      // Run two commands concurrently with different per-exec env
      const [result1, result2] = await Promise.all([
        env.exec("echo $VAR", { env: { VAR: "A" } }),
        env.exec("echo $VAR", { env: { VAR: "B" } })
      ]);

      // Each should see their own VAR value (isolated state)
      expect(result1.stdout.trim()).toBe("A");
      expect(result2.stdout.trim()).toBe("B");
    });

    it("state should not be modified by concurrent exec with options", async () => {
      const env = new Bash({ env: { ORIGINAL: "value" } });

      await Promise.all([
        env.exec("echo $A", { env: { A: "1" } }),
        env.exec("echo $B", { env: { B: "2" } })
      ]);

      // Original state should be unchanged
      expect(env.getEnv().ORIGINAL).toBe("value");
      // Temp vars should not persist (isolated state was used)
      expect(env.getEnv().A).toBeUndefined();
      expect(env.getEnv().B).toBeUndefined();
    });

    it("concurrent exec should each see shared original env", async () => {
      const env = new Bash({ env: { SHARED: "original" } });

      const [result1, result2] = await Promise.all([
        env.exec("echo $SHARED $VAR", { env: { VAR: "A" } }),
        env.exec("echo $SHARED $VAR", { env: { VAR: "B" } })
      ]);

      // Both should see the shared original value plus their own
      expect(result1.stdout.trim()).toBe("original A");
      expect(result2.stdout.trim()).toBe("original B");
    });

    it("concurrent exec without options should share state", async () => {
      const env = new Bash({ env: { COUNTER: "0" } });

      // Without per-exec options, state is shared (as expected)
      // These run sequentially due to async/await nature anyway
      const results = await Promise.all([
        env.exec("echo start"),
        env.exec("echo end")
      ]);

      expect(results[0].stdout.trim()).toBe("start");
      expect(results[1].stdout.trim()).toBe("end");
    });
  });

  describe("environment restoration verification", () => {
    it("should restore env using getEnv() after per-exec env", async () => {
      const env = new Bash({ env: { ORIGINAL: "value" } });

      // Verify initial state
      expect(env.getEnv().ORIGINAL).toBe("value");
      expect(env.getEnv().TEMP_VAR).toBeUndefined();

      // Run with per-exec env
      await env.exec("echo $TEMP_VAR", { env: { TEMP_VAR: "temporary" } });

      // Verify state is restored
      expect(env.getEnv().ORIGINAL).toBe("value");
      expect(env.getEnv().TEMP_VAR).toBeUndefined();
    });

    it("should restore overridden vars using getEnv()", async () => {
      const env = new Bash({ env: { VAR: "original" } });

      expect(env.getEnv().VAR).toBe("original");

      await env.exec("echo $VAR", { env: { VAR: "overridden" } });

      expect(env.getEnv().VAR).toBe("original");
    });

    it("should restore cwd using getCwd() after per-exec cwd", async () => {
      const env = new Bash({
        cwd: "/home",
        files: { "/tmp/file": "content" }
      });

      expect(env.getCwd()).toBe("/home");

      await env.exec("pwd", { cwd: "/tmp" });

      expect(env.getCwd()).toBe("/home");
    });

    it("should not leak command-set variables when using per-exec env", async () => {
      const env = new Bash({ env: { KEEP: "keep" } });

      // Command sets a new variable, but we're using per-exec env
      await env.exec("export NEW_VAR=created", { env: { TEMP: "temp" } });

      // NEW_VAR should not exist because env was restored
      expect(env.getEnv().NEW_VAR).toBeUndefined();
      expect(env.getEnv().TEMP).toBeUndefined();
      expect(env.getEnv().KEEP).toBe("keep");
    });

    it("should not leak command modifications to existing vars", async () => {
      const env = new Bash({ env: { VAR: "original" } });

      // Command modifies VAR, but we're using per-exec env
      await env.exec("export VAR=modified", { env: { OTHER: "other" } });

      // VAR should be restored to original
      expect(env.getEnv().VAR).toBe("original");
    });
  });

  describe("sleep command with mock clock", () => {
    it("should use mock sleep function", async () => {
      const clock = createMockClock();
      const env = new Bash({ sleep: clock.sleep });

      const promise = env.exec("sleep 1");

      // Wait for sleep to be registered
      await waitFor(() => clock.pendingCount === 1);

      // Advance clock
      clock.advance(1000);

      const result = await promise;
      expect(result.exitCode).toBe(0);
      expect(clock.pendingCount).toBe(0);
    });

    it("should parse duration with suffix", async () => {
      const clock = createMockClock();
      const env = new Bash({ sleep: clock.sleep });

      // Start sleep with minute suffix
      const promise = env.exec("sleep 0.5m");

      await waitFor(() => clock.pendingCount === 1);

      // 30 seconds = 0.5 minutes
      clock.advance(30000);

      const result = await promise;
      expect(result.exitCode).toBe(0);
    });

    it("should handle multiple sleep arguments", async () => {
      const clock = createMockClock();
      const env = new Bash({ sleep: clock.sleep });

      // GNU sleep sums multiple arguments
      const promise = env.exec("sleep 1 2");

      await waitFor(() => clock.pendingCount === 1);

      // First advance - not enough (sleep 1 2 = 3 seconds total)
      clock.advance(2000);
      // pendingCount should still be 1
      expect(clock.pendingCount).toBe(1);

      // Second advance completes
      clock.advance(1000);

      const result = await promise;
      expect(result.exitCode).toBe(0);
    });
  });

  describe("concurrent execution with sleep (mock clock)", () => {
    it("multiple concurrent sleeps should all complete independently", async () => {
      const clock = createMockClock();
      const env = new Bash({ sleep: clock.sleep });

      // Start three sleeps with different durations
      const p1 = env.exec("sleep 1; echo done1");
      const p2 = env.exec("sleep 2; echo done2");
      const p3 = env.exec("sleep 3; echo done3");

      await waitFor(() => clock.pendingCount === 3);

      // Advance 1 second - first should complete
      clock.advance(1000);
      const r1 = await p1;
      expect(r1.stdout).toBe("done1\n");
      expect(clock.pendingCount).toBe(2);

      // Advance another second - second should complete
      clock.advance(1000);
      const r2 = await p2;
      expect(r2.stdout).toBe("done2\n");
      expect(clock.pendingCount).toBe(1);

      // Advance final second - third should complete
      clock.advance(1000);
      const r3 = await p3;
      expect(r3.stdout).toBe("done3\n");
      expect(clock.pendingCount).toBe(0);
    });

    it("concurrent execs with per-exec env should be isolated during sleep", async () => {
      const clock = createMockClock();
      const env = new Bash({
        sleep: clock.sleep,
        env: { SHARED: "original" }
      });

      // Start concurrent commands with different env
      const p1 = env.exec('sleep 1; echo "A=$A SHARED=$SHARED"', {
        env: { A: "value_A" }
      });
      const p2 = env.exec('sleep 1; echo "B=$B SHARED=$SHARED"', {
        env: { B: "value_B" }
      });

      await waitFor(() => clock.pendingCount === 2);

      // Advance clock to complete both
      clock.advance(1000);

      const [r1, r2] = await Promise.all([p1, p2]);

      // Each should see their own env, not the other's
      expect(r1.stdout).toBe("A=value_A SHARED=original\n");
      expect(r2.stdout).toBe("B=value_B SHARED=original\n");
    });

    it("state modifications during concurrent sleep should be isolated", async () => {
      const clock = createMockClock();
      const env = new Bash({
        sleep: clock.sleep,
        env: { VAR: "initial" }
      });

      // Command 1: modify VAR then sleep
      const p1 = env.exec("export VAR=modified; sleep 2; echo $VAR", {
        env: { MARKER: "1" }
      });

      // Command 2: read VAR immediately (before p1's sleep completes)
      const p2 = env.exec("sleep 1; echo $VAR", { env: { MARKER: "2" } });

      await waitFor(() => clock.pendingCount === 2);

      // Advance 1 second - p2 completes first
      clock.advance(1000);
      const r2 = await p2;
      // p2 should see isolated copy of initial env, not p1's modification
      expect(r2.stdout).toBe("initial\n");

      // Advance another second - p1 completes
      clock.advance(1000);
      const r1 = await p1;
      // p1 should see its own modification
      expect(r1.stdout).toBe("modified\n");

      // Original env should be unchanged
      expect(env.getEnv().VAR).toBe("initial");
    });

    it("high concurrency stress test", async () => {
      const clock = createMockClock();
      const env = new Bash({
        sleep: clock.sleep,
        env: { BASE: "shared" }
      });

      // Start 10 concurrent commands
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(
          env.exec(`sleep ${i % 3}; echo "ID=$ID BASE=$BASE"`, {
            env: { ID: String(i) }
          })
        );
      }

      await waitFor(() => clock.pendingCount === 10);

      // Advance clock to complete all
      clock.advance(2000);

      const results = await Promise.all(promises);

      // Verify each result has correct isolated env
      for (let i = 0; i < 10; i++) {
        expect(results[i].stdout).toBe(`ID=${i} BASE=shared\n`);
        expect(results[i].exitCode).toBe(0);
      }

      // Original env unchanged
      expect(env.getEnv().BASE).toBe("shared");
      expect(env.getEnv().ID).toBeUndefined();
    });

    it("interleaved operations: file writes during concurrent sleeps", async () => {
      const clock = createMockClock();
      const env = new Bash({
        sleep: clock.sleep,
        files: { "/data/base.txt": "base" }
      });

      // Command 1: write to file then sleep
      const p1 = env.exec(
        'echo "from_p1" > /data/p1.txt; sleep 2; cat /data/p1.txt',
        { env: { CMD: "1" } }
      );

      // Command 2: write different file then sleep
      const p2 = env.exec(
        'echo "from_p2" > /data/p2.txt; sleep 1; cat /data/p2.txt',
        { env: { CMD: "2" } }
      );

      await waitFor(() => clock.pendingCount === 2);

      // Advance 1 second
      clock.advance(1000);
      const r2 = await p2;
      expect(r2.stdout).toBe("from_p2\n");

      // Advance another second
      clock.advance(1000);
      const r1 = await p1;
      expect(r1.stdout).toBe("from_p1\n");

      // Both files should exist (fs is shared, not isolated)
      const checkP1 = await env.exec("cat /data/p1.txt");
      const checkP2 = await env.exec("cat /data/p2.txt");
      expect(checkP1.stdout).toBe("from_p1\n");
      expect(checkP2.stdout).toBe("from_p2\n");
    });

    it("concurrent cwd changes should be isolated", async () => {
      const clock = createMockClock();
      const env = new Bash({
        sleep: clock.sleep,
        cwd: "/home",
        files: {
          "/home/file.txt": "home",
          "/tmp/file.txt": "tmp",
          "/var/file.txt": "var"
        }
      });

      // Three commands with different cwd
      const p1 = env.exec("sleep 1; pwd; cat file.txt", { cwd: "/home" });
      const p2 = env.exec("sleep 1; pwd; cat file.txt", { cwd: "/tmp" });
      const p3 = env.exec("sleep 1; pwd; cat file.txt", { cwd: "/var" });

      await waitFor(() => clock.pendingCount === 3);
      clock.advance(1000);

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

      expect(r1.stdout).toBe("/home\nhome");
      expect(r2.stdout).toBe("/tmp\ntmp");
      expect(r3.stdout).toBe("/var\nvar");

      // Original cwd should be unchanged
      expect(env.getCwd()).toBe("/home");
    });

    it("function definitions should not leak between isolated execs", async () => {
      const clock = createMockClock();
      const env = new Bash({
        sleep: clock.sleep
      });

      // Command 1: define a function in isolated context
      const p1 = env.exec("myfunc() { echo from_p1; }; sleep 1; myfunc", {
        env: { MARKER: "1" }
      });

      // Command 2: try to call that function (should fail)
      const p2 = env.exec("sleep 2; myfunc 2>&1 || echo not_found", {
        env: { MARKER: "2" }
      });

      await waitFor(() => clock.pendingCount === 2);
      clock.advance(1000);
      const r1 = await p1;
      expect(r1.stdout).toBe("from_p1\n");

      clock.advance(1000);
      const r2 = await p2;
      // Function should not be visible in isolated context
      expect(r2.stdout).toContain("not_found");
    });

    it("shell options should not leak between isolated execs", async () => {
      const clock = createMockClock();
      const env = new Bash({
        sleep: clock.sleep
      });

      // Command 1: set errexit in isolated context
      const p1 = env.exec("set -e; sleep 1; false; echo should_not_see", {
        env: { MARKER: "1" }
      });

      // Command 2: run failing command without errexit
      const p2 = env.exec("sleep 2; false; echo should_see", {
        env: { MARKER: "2" }
      });

      await waitFor(() => clock.pendingCount === 2);
      clock.advance(1000);
      const r1 = await p1;
      expect(r1.stdout).toBe(""); // errexit stopped execution
      expect(r1.exitCode).toBe(1);

      clock.advance(1000);
      const r2 = await p2;
      expect(r2.stdout).toBe("should_see\n"); // no errexit
      expect(r2.exitCode).toBe(0);
    });

    it("each exec is isolated even without per-exec options", async () => {
      const clock = createMockClock();
      const env = new Bash({
        sleep: clock.sleep,
        env: { COUNTER: "0" }
      });

      // Each exec is like a new shell - state is never shared
      const p1 = env.exec("export COUNTER=from_p1; sleep 1; echo done1");
      const p2 = env.exec("sleep 2; echo $COUNTER");

      await waitFor(() => clock.pendingCount === 2);
      clock.advance(1000);
      await p1;

      clock.advance(1000);
      const r2 = await p2;

      // p2 sees original value because each exec is isolated
      expect(r2.stdout).toBe("0\n");
    });

    it("race condition test: many concurrent modifications", async () => {
      const clock = createMockClock();
      const env = new Bash({
        sleep: clock.sleep,
        env: { ORIGINAL: "unchanged" }
      });

      // Start many concurrent execs that try to modify state
      const promises = [];
      for (let i = 0; i < 20; i++) {
        promises.push(
          env.exec(`export NEW_VAR_${i}=value; sleep 0.1; echo $ORIGINAL`, {
            env: { INDEX: String(i) }
          })
        );
      }

      await waitFor(() => clock.pendingCount === 20);
      // Advance clock
      clock.advance(100);
      const results = await Promise.all(promises);

      // All should see the original value
      for (const result of results) {
        expect(result.stdout).toBe("unchanged\n");
      }

      // Original env should be completely unchanged
      expect(env.getEnv().ORIGINAL).toBe("unchanged");
      // None of the NEW_VAR_X should exist
      for (let i = 0; i < 20; i++) {
        expect(env.getEnv()[`NEW_VAR_${i}`]).toBeUndefined();
      }
    });
  });

  describe("logger option", () => {
    function createMockLogger(): BashLogger & {
      logs: Array<{
        level: string;
        message: string;
        data?: Record<string, unknown>;
      }>;
    } {
      const logs: Array<{
        level: string;
        message: string;
        data?: Record<string, unknown>;
      }> = [];
      return {
        logs,
        info(message: string, data?: Record<string, unknown>) {
          logs.push({ level: "info", message, data });
        },
        debug(message: string, data?: Record<string, unknown>) {
          logs.push({ level: "debug", message, data });
        }
      };
    }

    it("should not log when logger is not provided", async () => {
      const env = new Bash();
      const result = await env.exec("echo hello");
      expect(result.stdout).toBe("hello\n");
      // No errors, just ensure it works without logger
    });

    it("should log exec command at info level", async () => {
      const logger = createMockLogger();
      const env = new Bash({ logger });

      await env.exec("echo hello");

      const execLog = logger.logs.find((l) => l.message === "exec");
      expect(execLog).toBeDefined();
      expect(execLog?.level).toBe("info");
      expect(execLog?.data?.command).toBe("echo hello");
    });

    it("should log stdout at debug level", async () => {
      const logger = createMockLogger();
      const env = new Bash({ logger });

      await env.exec("echo hello");

      const stdoutLog = logger.logs.find((l) => l.message === "stdout");
      expect(stdoutLog).toBeDefined();
      expect(stdoutLog?.level).toBe("debug");
      expect(stdoutLog?.data?.output).toBe("hello\n");
    });

    it("should log stderr at info level", async () => {
      const logger = createMockLogger();
      const env = new Bash({ logger });

      await env.exec("echo error >&2");

      const stderrLog = logger.logs.find((l) => l.message === "stderr");
      expect(stderrLog).toBeDefined();
      expect(stderrLog?.level).toBe("info");
      expect(stderrLog?.data?.output).toBe("error\n");
    });

    it("should log exit code at info level", async () => {
      const logger = createMockLogger();
      const env = new Bash({ logger });

      await env.exec("echo hello");

      const exitLog = logger.logs.find((l) => l.message === "exit");
      expect(exitLog).toBeDefined();
      expect(exitLog?.level).toBe("info");
      expect(exitLog?.data?.exitCode).toBe(0);
    });

    it("should log non-zero exit code", async () => {
      const logger = createMockLogger();
      const env = new Bash({ logger });

      await env.exec("exit 42");

      const exitLog = logger.logs.find((l) => l.message === "exit");
      expect(exitLog).toBeDefined();
      expect(exitLog?.data?.exitCode).toBe(42);
    });

    it("should log in correct order: exec, stdout/stderr, exit", async () => {
      const logger = createMockLogger();
      const env = new Bash({ logger });

      await env.exec("echo out; echo err >&2");

      expect(logger.logs[0].message).toBe("exec");
      expect(logger.logs[logger.logs.length - 1].message).toBe("exit");
    });

    it("should not log stdout when empty", async () => {
      const logger = createMockLogger();
      const env = new Bash({ logger });

      await env.exec("true");

      const stdoutLog = logger.logs.find((l) => l.message === "stdout");
      expect(stdoutLog).toBeUndefined();
    });

    it("should not log stderr when empty", async () => {
      const logger = createMockLogger();
      const env = new Bash({ logger });

      await env.exec("echo hello");

      const stderrLog = logger.logs.find((l) => l.message === "stderr");
      expect(stderrLog).toBeUndefined();
    });

    it("should not log empty commands", async () => {
      const logger = createMockLogger();
      const env = new Bash({ logger });

      await env.exec("");
      await env.exec("   ");

      expect(logger.logs.length).toBe(0);
    });

    it("should log parse errors", async () => {
      const logger = createMockLogger();
      const env = new Bash({ logger });

      await env.exec("echo ${");

      const execLog = logger.logs.find((l) => l.message === "exec");
      expect(execLog).toBeDefined();

      const stderrLog = logger.logs.find((l) => l.message === "stderr");
      expect(stderrLog).toBeDefined();
      expect(stderrLog?.data?.output).toContain("syntax error");

      const exitLog = logger.logs.find((l) => l.message === "exit");
      expect(exitLog?.data?.exitCode).toBe(2);
    });
  });
});
