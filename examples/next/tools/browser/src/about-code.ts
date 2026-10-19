// The code samples in the "How it works" dialog: this demo's agent, built
// up in three steps plus what the model writes, cut down to the internal
// hostname parts. See server.ts for the real thing.

/** One step of the agent's code. Each is a whole file that builds on the last. */
export type CodeStep = {
  label: string;
  title: string;
  caption: string;
  /** For highlighting: the agent is TypeScript, the model writes JavaScript. */
  language: "ts" | "js";
  code: string;
  /** 1-based line numbers this step adds, highlighted in the dialog. */
  added: readonly number[];
};

/** Lines ending in this marker are new in their step. */
const ADDED = " //+";

/** Strip the markers, remembering which lines had one. */
function step(
  meta: Omit<CodeStep, "code" | "added" | "language">,
  marked: string
): CodeStep {
  const lines = marked.split("\n");
  const added = lines.flatMap((line, i) =>
    line.endsWith(ADDED) ? [i + 1] : []
  );
  const code = lines
    .map((line) => (line.endsWith(ADDED) ? line.slice(0, -ADDED.length) : line))
    .join("\n");
  return { ...meta, language: "ts", code, added };
}

const PI_AGENT = `import { DurableObject } from "cloudflare:workers";
import { Workspace } from "@cloudflare/computer";
import { withWorkspaceContainer } from "@cloudflare/computer/backends/container";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";

class Base extends DurableObject<Env> {}

export class BrowserAgent extends withWorkspaceContainer(Base) {
  // Files in /workspace, synced to a Linux container.
  readonly workspace = new Workspace({
    // set up your workspace storage and container backend
  });

  readonly harness = new PiHarness({
    // set up your pi harness: model, system prompt, workspace tools
  });

  readonly lifecycle = Lifecycle.install(this).use(this.harness);
}`;

const WITH_BROWSER = `import { DurableObject } from "cloudflare:workers";
import { Workspace } from "@cloudflare/computer";
import { withWorkspaceContainer } from "@cloudflare/computer/backends/container";
import { Browser, browserRun } from "agents/browser"; //+
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { z } from "zod"; //+
import { serveWorkspaceFolder } from "./files-host"; //+

// Browser Run calls back into this Worker through the router. //+
export { CodemodeRuntime, InternalHostRouter } from "agents/browser"; //+
export { DocsSite } from "./docs-site"; // a WorkerEntrypoint //+

class Base extends DurableObject<Env> {}

export class BrowserAgent extends withWorkspaceContainer(Base) {
  readonly workspace = new Workspace({
    // set up your workspace storage and container backend
  });

  // A browser that only opens the three internal hostnames. //+
  readonly browser = new Browser({ //+
    provider: browserRun(this.env.BROWSER, { //+
      guardrails: { allowedDomains: [] }, // no internet //+
      internalHosts: { //+
        router: this.ctx.exports.InternalHostRouter, //+
        hosts: { //+
          // Served by the agent: the model assigns a port. //+
          "preview.internal": { //+
            description: "A dev server in your container. Assign its port.", //+
            target: z.object({ port: z.number().int().min(1024) }), //+
            fetch: (request, { port }) => //+
              this.getWorkspaceContainer().fetchPort(port, request) //+
          }, //+
          // Served by the agent: the model assigns a folder. //+
          "files.internal": { //+
            description: "Static files from a workspace folder.", //+
            target: z.object({ folder: z.string() }), //+
            fetch: (request, { folder }) => //+
              serveWorkspaceFolder(this.workspace, request, folder) //+
          }, //+
          // Served by a Worker directly, without waking the agent. //+
          "docs.internal": { //+
            description: "Your instructions for building things.", //+
            worker: this.ctx.exports.DocsSite //+
          } //+
        } //+
      } //+
    }) //+
  }); //+

  readonly harness = new PiHarness({
    // set up your pi harness, and add the browser tool:
    // browserTool({ browser: this.browser, ... }) from agents/browser/pi //+
  });

  readonly lifecycle = Lifecycle.install(this)
    .use(this.browser) //+
    .use(this.harness);
}`;

const MODEL_CODE = `async () => {
  const { url } = await hosts.assign("preview.internal", { port: 5173 });
  await cdp.send({
    method: "Page.navigate",
    params: { url },
    sessionId: "active"
  });
  // …wait for the page to load, then read it
}`;

const WITH_ROUTING = `import { DurableObject } from "cloudflare:workers";
import { Workspace } from "@cloudflare/computer";
import { withWorkspaceContainer } from "@cloudflare/computer/backends/container";
import { Browser, browserRun, type InternalHostMessage } from "agents/browser"; //+
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";

export { CodemodeRuntime, InternalHostRouter } from "agents/browser";
export { DocsSite } from "./docs-site";

class Base extends DurableObject<Env> {}

export class BrowserAgent extends withWorkspaceContainer(Base) {
  readonly workspace = new Workspace({
    // set up your workspace storage and container backend
  });

  readonly browser = new Browser({
    // the browser and its three hosts, as in step 2
  });

  readonly harness = new PiHarness({
    // set up your pi harness, with the browser tool
  });

  readonly lifecycle = Lifecycle.install(this)
    .use(this.browser)
    .use(this.harness);

  // The router hands preview.internal and files.internal requests to //+
  // this method. An Agent has it built in; a plain Durable Object adds it. //+
  fetchInternalHost(message: InternalHostMessage) { //+
    return this.browser.fetchInternalHost(message); //+
  } //+
}`;

export const CODE_STEPS: readonly CodeStep[] = [
  step(
    {
      label: "Pi agent",
      title: "Start with a pi agent",
      caption:
        "A Durable Object with a container workspace and a pi harness. Nothing about the browser yet."
    },
    PI_AGENT
  ),
  step(
    {
      label: "Add the browser",
      title: "Add a browser with three internal hosts",
      caption:
        "A host with fetch is served by your agent's code, with the target the model assigned. A host with worker is served by a Worker directly."
    },
    WITH_BROWSER
  ),
  step(
    {
      label: "Route requests",
      title: "Hand the browser's requests to it",
      caption:
        "Browser Run sends requests for preview.internal and files.internal to InternalHostRouter, which calls fetchInternalHost on this agent."
    },
    WITH_ROUTING
  ),
  {
    label: "Model writes",
    title: "What the model writes",
    caption:
      "Inside the browser tool. A host nobody has assigned answers 502 and says to call hosts.assign.",
    language: "js",
    code: MODEL_CODE,
    added: []
  }
];
