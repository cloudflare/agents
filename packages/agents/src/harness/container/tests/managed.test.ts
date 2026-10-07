import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { forwardEgress } from "../egress";

function fresh() {
  return env.CONTAINER_MANAGED_TEST.getByName(crypto.randomUUID());
}

async function until(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe("ContainerHarness with a managed image", () => {
  it("sets up debian-trixie once, snapshots it, and restores the snapshot after", async () => {
    const stub = fresh();
    expect((await stub.prompt("hello")).status).toBe("done");
    const first = await stub.setup();
    expect(first.lastStart).toMatchObject({
      image: "cloudflare/debian-trixie",
      instance: "standard-1",
      enableInternet: true
    });
    expect(first.execs.map((each) => each.cmd)).toEqual([
      expect.stringContaining("useradd"),
      expect.stringContaining("git"),
      "npm install --global --no-fund --no-audit @anthropic-ai/claude-code@9.9.9",
      "claude plugin install french@my-mods",
      expect.stringContaining("cat > /opt/harness/daemon.mjs")
    ]);
    // Setup runs as root, except steps for the agent's own home.
    expect(first.execs.map((each) => [each.user, each.home])).toEqual([
      ["root", "/root"],
      ["root", "/root"],
      ["root", "/root"],
      ["10001:10001", "/home/agent"],
      ["root", "/root"]
    ]);
    // The daemon is written from the bundle the harness carries.
    expect(first.execs.at(-1)?.stdinBytes).toBeGreaterThan(1_000);
    expect(first.snapshots).toBe(1);

    // A container that dies keeps nothing: the next one starts from the
    // setup snapshot, without setting up again.
    await stub.crashContainer();
    expect((await stub.prompt("again")).status).toBe("done");
    const second = await stub.setup();
    expect(second.lastStart).toMatchObject({
      containerSnapshot: { id: "snapshot-1" }
    });
    expect(second.lastStart).not.toHaveProperty("image");
    expect(second.execs).toEqual([]);
    expect(second.snapshots).toBe(1);
  });

  it("snapshots the workspace when it stops the container, and starts from it", async () => {
    const stub = fresh();
    await stub.prompt("one");
    // The harness stops the container (idle or `stop()`): the whole
    // filesystem, workspace included, is snapshotted first.
    await stub.stopContainer();
    expect((await stub.setup()).snapshots).toBe(2);
    await stub.prompt("two");
    const next = await stub.setup();
    expect(next.lastStart).toMatchObject({
      containerSnapshot: { id: "snapshot-2" }
    });
    expect(next.execs).toEqual([]);
  });

  it("keeps credentials out of the container and adds them at the egress", async () => {
    const stub = fresh();
    await stub.prompt("hello");
    const { env: containerEnv, intercepts } = await stub.setup();
    expect(containerEnv).toMatchObject({
      CF_HARNESS_ADAPTER: "claude-code",
      CF_HARNESS_USER: "10001:10001",
      ANTHROPIC_BASE_URL: "http://anthropic.harness.internal",
      ANTHROPIC_API_KEY: "harness-egress"
    });
    expect(JSON.stringify(containerEnv)).not.toContain("gw-secret");
    expect(intercepts).toEqual(["anthropic.harness.internal"]);

    const probe = await stub.egressProbe();
    expect(probe).toMatchObject({ status: 200, body: "upstream ok" });
    expect(probe.upstream?.url).toBe(
      "https://gateway.example/v1/acct/gw/anthropic/v1/messages?beta=true"
    );
    // The placeholder key is replaced by the real one.
    expect(probe.upstream?.headers).toMatchObject({
      "x-api-key": "gw-secret",
      "cf-aig-metadata": '{"project":"tests"}',
      "content-type": "application/json"
    });
  });

  it("routes egress again for a container restored from a snapshot", async () => {
    const stub = fresh();
    await stub.prompt("one");
    await stub.stopContainer();
    await stub.prompt("two");
    expect((await stub.setup()).intercepts).toEqual([
      "anthropic.harness.internal"
    ]);
  });

  it("keeps the workspace snapshot through a transient start failure", async () => {
    const stub = fresh();
    await stub.prompt("one");
    await stub.stopContainer(); // workspace snapshot-2
    await stub.failSnapshotStart(true);
    const receipt = await stub.submit("two");
    await until(async () => {
      await runDurableObjectAlarm(stub);
      return (await stub.container()).startAttempts >= 3;
    }, "a failed start");
    await stub.failSnapshotStart(false);
    expect((await stub.wait(receipt.operationId)).status).toBe("done");
    // Retried from the same workspace, not set up afresh.
    expect((await stub.setup()).lastStart).toMatchObject({
      containerSnapshot: { id: "snapshot-2" }
    });
  });

  it("forgets snapshots that keep failing, and sets up afresh", async () => {
    const stub = fresh();
    await stub.prompt("one");
    await stub.stopContainer();
    await stub.failSnapshotStart(true);
    // Each failure looks older than the last, so persistent failures pass
    // the forgetting threshold (three, over ten minutes) one by one.
    const first = await stub.submit("two");
    await until(async () => {
      await stub.backdateSnapshots(11 * 60_000);
      await runDurableObjectAlarm(stub);
      return (await stub.pending()).length === 0;
    }, "the start failures to give up");
    expect((await stub.wait(first.operationId)).reason).toBe(
      "container_unavailable"
    );
    // The workspace snapshot is gone; the setup snapshot goes on its next
    // failure, and the attempt after that sets up afresh.
    const second = await stub.submit("three");
    await until(async () => {
      await stub.backdateSnapshots(11 * 60_000);
      await runDurableObjectAlarm(stub);
      return (await stub.setup()).lastStart.image !== undefined;
    }, "a fresh setup");
    await stub.failSnapshotStart(false);
    expect((await stub.wait(second.operationId)).status).toBe("done");
  });

  it("skips snapshots too old to restore", async () => {
    const stub = fresh();
    await stub.prompt("one");
    await stub.stopContainer();
    await stub.backdateSnapshots(30 * 24 * 60 * 60_000);
    await stub.prompt("two");
    expect((await stub.setup()).lastStart).toMatchObject({
      image: "cloudflare/debian-trixie"
    });
  });

  it("does not restore an older workspace when the latest snapshot fails", async () => {
    const stub = fresh();
    await stub.prompt("one");
    await stub.stopContainer(); // workspace snapshot-2
    await stub.prompt("two");
    await stub.failSnapshot(true);
    await stub.stopContainer(); // fails: snapshot-2 is now stale
    await stub.failSnapshot(false);
    await stub.prompt("three");
    // The clean setup snapshot, not the stale workspace.
    expect((await stub.setup()).lastStart).toMatchObject({
      containerSnapshot: { id: "snapshot-1" }
    });
  });

  it("rejects events() for an unknown session", async () => {
    expect(await fresh().eventsOfMissing()).toMatch(
      /Unknown container session/
    );
  });

  it("reports a failed setup step", async () => {
    const stub = fresh();
    await stub.failExec("npm install");
    const receipt = await stub.submit("hello");
    await until(async () => {
      await runDurableObjectAlarm(stub);
      return (await stub.pending()).length === 0;
    }, "the setup failures to give up");
    expect(await stub.wait(receipt.operationId)).toMatchObject({
      status: "unanswered",
      reason: "container_unavailable"
    });
  });
});

describe("forwardEgress", () => {
  const routes = [
    {
      host: "openai.harness.internal",
      upstream: "https://api.openai.com/v1/",
      headers: { authorization: "Bearer real" },
      strip: ["authorization", "x-api-key"]
    }
  ];

  it("swaps the placeholder credential for the real one", async () => {
    let seen: Request | undefined;
    const response = await forwardEgress(
      new Request("http://openai.harness.internal/responses", {
        method: "POST",
        headers: { authorization: "Bearer harness-egress" },
        body: "{}"
      }),
      routes,
      async (url, init) => {
        seen = new Request(url, init);
        return new Response("ok");
      }
    );
    expect(await response.text()).toBe("ok");
    expect(seen?.url).toBe("https://api.openai.com/v1/responses");
    expect(seen?.headers.get("authorization")).toBe("Bearer real");
    expect(seen?.redirect).toBe("manual");
    expect(await seen?.text()).toBe("{}");
  });

  it("refuses a host without a route", async () => {
    const response = await forwardEgress(
      new Request("http://elsewhere.example/"),
      routes,
      async () => new Response("should not be called")
    );
    expect(response.status).toBe(403);
  });
});

describe("ContainerHarness options", () => {
  it("keeps the idle stop ahead of the platform's six-hour limit", async () => {
    const { ContainerHarness } = await import("../harness");
    const { containerAgent } = await import("../agents");
    const agent = containerAgent({ image: "x", adapter: "a" });
    // SAFETY: the constructor only checks its options.
    const container = {} as unknown as Container;
    expect(
      () =>
        new ContainerHarness({
          container,
          agent,
          idleTimeoutMs: 6 * 60 * 60_000
        })
    ).toThrow(/at most six hours less two minutes/);
    expect(
      () =>
        new ContainerHarness({
          container,
          agent,
          idleTimeoutMs: 6 * 60 * 60_000 - 2 * 60_000
        })
    ).not.toThrow();
  });

  it("refuses an egress upstream that is not https", async () => {
    const { ContainerHarness } = await import("../harness");
    const { containerAgent } = await import("../agents");
    const agent = containerAgent({
      image: "x",
      adapter: "a",
      egress: [
        {
          host: "api.harness.internal",
          upstream: "http://plain.example",
          headers: {},
          strip: []
        }
      ]
    });
    // SAFETY: the constructor only checks its options; nothing is called on
    // the container or the egress before it throws.
    const container = {} as unknown as Container;
    const egress = () => ({}) as unknown as Fetcher;
    expect(() => new ContainerHarness({ container, agent, egress })).toThrow(
      /must be an https URL/
    );
  });
});

describe("presets", () => {
  it("send the key the provider's way, to its own API by default", async () => {
    const { claudeCode, codex } = await import("../agents");
    const direct = codex({ apiKey: "sk-real" });
    expect(direct.egress).toEqual([
      {
        host: "openai.harness.internal",
        upstream: "https://api.openai.com/v1",
        headers: { authorization: "Bearer sk-real" },
        strip: ["authorization", "x-api-key", "cf-aig-authorization"]
      }
    ]);
    expect(JSON.stringify(direct.env)).not.toContain("sk-real");
    expect(claudeCode({ apiKey: "k" }).egress[0]).toMatchObject({
      upstream: "https://api.anthropic.com",
      headers: { "x-api-key": "k" }
    });
  });

  it("authenticate with headers alone, for a BYOK gateway", async () => {
    const { claudeCode } = await import("../agents");
    const byok = claudeCode({
      baseUrl: "https://gw.example/anthropic",
      headers: { "cf-aig-authorization": "Bearer t" }
    });
    expect(byok.egress[0]).toMatchObject({
      upstream: "https://gw.example/anthropic",
      headers: { "cf-aig-authorization": "Bearer t" }
    });
  });
});
