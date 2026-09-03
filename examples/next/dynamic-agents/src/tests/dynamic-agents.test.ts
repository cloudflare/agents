import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";

function uniqueName() {
  return `supervisor-${Math.random().toString(36).slice(2)}`;
}

const V2_CODE = `import { DurableObject } from "cloudflare:workers";

export class Sandbox extends DurableObject {
  fetch(request) {
    const url = new URL(request.url);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS hits (path TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0)"
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO hits (path, n) VALUES (?, 1) ON CONFLICT (path) DO UPDATE SET n = n + 1",
      url.pathname
    );
    const [{ n }] = this.ctx.storage.sql
      .exec("SELECT n FROM hits WHERE path = ?", url.pathname)
      .toArray();
    return Response.json({ version: "v2", path: url.pathname, hits: n });
  }
}
`;

type GadgetResult = { version: string; path: string; hits: number };

describe("supervised dynamic code in facets", () => {
  it("runs user-submitted code with its own persistent SQLite", async () => {
    const supervisor = await getAgentByName(env.Supervisor, uniqueName());
    await supervisor.createGadget("counter");

    const first = (await supervisor.invokeGadget(
      "counter",
      "/a"
    )) as GadgetResult;
    const second = (await supervisor.invokeGadget(
      "counter",
      "/a"
    )) as GadgetResult;
    expect(first).toMatchObject({ version: "v1", hits: 1 });
    expect(second).toMatchObject({ version: "v1", hits: 2 });

    // The gadget's hits table lives in the FACET's SQLite, not the
    // supervisor's — the supervisor only holds the code registry.
    expect(await supervisor.supervisorTables()).not.toContain("hits");
  });

  it("returns the selected gadget's current source", async () => {
    const supervisor = await getAgentByName(env.Supervisor, uniqueName());
    await supervisor.createGadget("editable");

    expect((await supervisor.getGadget("editable")).code).toContain(
      'version: "v1"'
    );

    await supervisor.updateGadgetCode("editable", V2_CODE);
    expect(await supervisor.getGadget("editable")).toMatchObject({
      name: "editable",
      code: V2_CODE,
      version: 2
    });
  });

  it("upgrades gadget code over the same storage", async () => {
    const supervisor = await getAgentByName(env.Supervisor, uniqueName());
    await supervisor.createGadget("upgradeable");
    await supervisor.invokeGadget("upgradeable", "/x");
    await supervisor.invokeGadget("upgradeable", "/x");

    const { version } = await supervisor.updateGadgetCode(
      "upgradeable",
      V2_CODE
    );
    expect(version).toBe(2);

    // New code, same facet storage: the counter continues from 2.
    const result = (await supervisor.invokeGadget(
      "upgradeable",
      "/x"
    )) as GadgetResult;
    expect(result).toMatchObject({ version: "v2", hits: 3 });
  });

  it("abort preserves the gadget's storage", async () => {
    const supervisor = await getAgentByName(env.Supervisor, uniqueName());
    await supervisor.createGadget("resilient");
    await supervisor.invokeGadget("resilient", "/k");

    await supervisor.abortGadget("resilient", "misbehaving");

    const result = (await supervisor.invokeGadget(
      "resilient",
      "/k"
    )) as GadgetResult;
    expect(result.hits).toBe(2);
  });

  it("delete wipes the gadget's storage; a recreated gadget starts empty", async () => {
    const supervisor = await getAgentByName(env.Supervisor, uniqueName());
    await supervisor.createGadget("ephemeral");
    await supervisor.invokeGadget("ephemeral", "/k");
    await supervisor.deleteGadget("ephemeral");

    expect(await supervisor.listGadgets()).toEqual([]);

    await supervisor.createGadget("ephemeral");
    const result = (await supervisor.invokeGadget(
      "ephemeral",
      "/k"
    )) as GadgetResult;
    expect(result.hits).toBe(1);
  });
});
