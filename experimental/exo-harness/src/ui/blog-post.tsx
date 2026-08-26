import { ArrowLeftIcon } from "@phosphor-icons/react";

/** Renders the article explaining the Exo Harness self-modification experiment. */
export function ExoHarnessBlogPost() {
  return (
    <main className="flex-1 overflow-y-auto bg-kumo-base">
      <article className="mx-auto max-w-[760px] px-6 py-16 sm:py-24">
        <a
          href="/"
          className="mb-12 flex w-fit items-center gap-2 text-sm font-medium text-kumo-secondary no-underline hover:text-kumo-default"
        >
          <ArrowLeftIcon aria-hidden="true" size={16} />
          Back to agent
        </a>

        <header>
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-kumo-accent">
            Exo Harness
          </p>
          <h1 className="mt-5 text-4xl font-semibold leading-[1.05] tracking-[-0.04em] text-kumo-default sm:text-6xl">
            What does it mean for an agent to be self-modifying?
          </h1>
          <div className="mt-8 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-kumo-secondary">
            <span className="font-medium text-kumo-default">Ben Reitz</span>
            <span aria-hidden="true">·</span>
            <span>8 min read</span>
          </div>
        </header>

        <div className="mt-14 space-y-7 text-lg leading-8 text-kumo-default">
          <p className="text-xl leading-9">
            An agent harness is the software around a model that decides what it
            sees, what it can do, how a turn proceeds, and what survives into
            the next turn. The model produces tokens; the harness turns those
            tokens into a continuing agent.
          </p>
          <p>
            A self-modifying agent can change some of that machinery for future
            turns. The useful question is not whether the agent can change
            anything. Most agents can update memory or write files. The question
            is where change stops: what may the agent rewrite, and what must
            remain fixed?
          </p>
          <p>
            The simplest way to compare these systems is to look at what the
            agent can change and what it cannot. Who makes the change matters
            too: a harness can be deeply customizable for its human operator
            without being self-modifying for the agent. Then we can ask when
            changes take effect, whether they persist, and how to undo them.
          </p>

          <h2 className="pt-6 text-3xl font-semibold tracking-tight">
            Customizable is not the same as self-modifying
          </h2>
          <p>
            ChatGPT lets users change instructions and memory, but the product
            still owns the machinery that assembles a turn. Pi goes much
            further: extensions can replace tools, intercept events, rewrite
            context, customize compaction, and change the request sent to the
            model.
          </p>
          <p>
            But those extensions are normally selected and maintained by the
            person operating pi. The model may help write them, but it still
            works through a harness configured by a human. Self-modification
            begins when changing the harness becomes part of the agent's own
            continuing operation.
          </p>

          <h2 className="pt-6 text-3xl font-semibold tracking-tight">
            Prime Agent changes through layers
          </h2>
          <p>
            Prime Agent makes self-modification explicit in three different
            ways:
          </p>
          <ul className="list-disc space-y-3 pl-7 marker:text-kumo-secondary">
            <li>
              Its <strong>RLM runtime</strong> gives the model a persistent
              IPython session. The model can use Python to search and transform
              context, preserve state across turns, run commands, and delegate
              selected work to child agents.
            </li>
            <li>
              Its <strong>Continual Harness</strong> stores supplemental
              prompts, memories, skill descriptions, and subagent definitions.
              The agent can refine these records, persist them across sessions,
              inspect earlier versions, and roll them back. The base prompt
              remains fixed.
            </li>
            <li>
              Its <strong>skills and pi extensions</strong> provide a broader
              executable surface. Extensions can add tools and providers, change
              context and compaction, intercept tool calls, and customize the
              final model request.
            </li>
          </ul>
          <p>
            It would therefore be misleading to call Prime Agent simply
            structured or limited. Its Continual Harness is deliberately narrow,
            but the complete system is highly extensible. The TypeScript host
            still owns the agent loop, provider calls, transcript persistence,
            scheduling, and child-agent lifecycle.
          </p>

          <h2 className="pt-6 text-3xl font-semibold tracking-tight">
            Exo makes the executor replaceable
          </h2>
          <p>
            Exo separates a stable <code>exoharness</code> from a replaceable
            executor. The stable layer owns identity, append-only history,
            artifacts, secrets, and sandbox lifecycle. The executor owns prompt
            assembly, model calls, tool dispatch, memory, compaction, and the
            turn loop. That executor can be edited or replaced as a whole.
          </p>
          <p>
            This moves the boundary deeper than Prime Agent's persistent Python
            environment or Continual Harness. Exo can run an RLM executor, but
            RLM is only one option over the same durable substrate. The larger
            idea is that durable state should be separated from the code that
            interprets and acts on it.
          </p>

          <h2 className="pt-6 text-3xl font-semibold tracking-tight">
            Building the same split from Cloudflare primitives
          </h2>
          <p>
            Exo's separation looked native to Cloudflare. Durable identity and
            state map to Agents and Durable Objects. A mutable filesystem maps
            to Workspace. Isolated code execution maps to Dynamic Workers.
            Scheduling, version history, inference accounting, and remote
            artifacts already exist as separate platform capabilities.
          </p>
          <p>
            I built a proof of concept to see whether those primitives could
            form a deployed self-modifying agent. The agent runs in an isolated
            Durable Object and Workspace. It can rewrite its instructions, model
            and context policies, memory, tools, and a <code>runtime.js</code>{" "}
            file with hooks around turns, model steps, tool calls, output, and
            scheduled work.
          </p>
          <p>
            The main turn loop remains fixed. The Durable Object kernel owns
            authentication, tenant isolation, canonical history, quotas,
            capability checks, versioning, and recovery. This was an intentional
            first experiment: give the agent meaningful control without making
            the complete executor replaceable.
          </p>

          <h2 className="pt-6 text-3xl font-semibold tracking-tight">
            Where the pieces run
          </h2>
          <div className="overflow-x-auto rounded-xl border border-kumo-line">
            <table className="w-full min-w-[720px] border-collapse text-left text-base leading-7">
              <caption className="sr-only">
                Responsibilities and Cloudflare primitives used by each part of
                Exo Harness
              </caption>
              <thead className="bg-kumo-elevated">
                <tr>
                  <th className="border-b border-kumo-line px-4 py-3 font-semibold">
                    Part
                  </th>
                  <th className="border-b border-kumo-line px-4 py-3 font-semibold">
                    Responsibility
                  </th>
                  <th className="border-b border-kumo-line px-4 py-3 font-semibold">
                    Cloudflare primitive or SDK
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="border-b border-kumo-line px-4 py-3 font-medium">
                    Browser
                  </td>
                  <td className="border-b border-kumo-line px-4 py-3">
                    Chat UI, WebSocket connection, streaming messages, synced
                    state
                  </td>
                  <td className="border-b border-kumo-line px-4 py-3">
                    <code>agents/react</code>,{" "}
                    <code>@cloudflare/ai-chat/react</code>, Kumo
                  </td>
                </tr>
                <tr>
                  <td className="border-b border-kumo-line px-4 py-3 font-medium">
                    Entry Worker
                  </td>
                  <td className="border-b border-kumo-line px-4 py-3">
                    Serves the UI and routes agent connections
                  </td>
                  <td className="border-b border-kumo-line px-4 py-3">
                    Workers, Agents SDK routing
                  </td>
                </tr>
                <tr>
                  <td className="border-b border-kumo-line px-4 py-3 font-medium">
                    Fixed kernel
                  </td>
                  <td className="border-b border-kumo-line px-4 py-3">
                    Runs the turn loop and owns history, limits, capabilities,
                    versions, and recovery
                  </td>
                  <td className="border-b border-kumo-line px-4 py-3">
                    Durable Object, <code>AIChatAgent</code>
                  </td>
                </tr>
                <tr>
                  <td className="border-b border-kumo-line px-4 py-3 font-medium">
                    Editable filesystem
                  </td>
                  <td className="border-b border-kumo-line px-4 py-3">
                    Stores instructions, policies, memory, tools, and{" "}
                    <code>runtime.js</code>
                  </td>
                  <td className="border-b border-kumo-line px-4 py-3">
                    Workspace from <code>@cloudflare/computer</code>
                  </td>
                </tr>
                <tr>
                  <td className="border-b border-kumo-line px-4 py-3 font-medium">
                    Mutable execution
                  </td>
                  <td className="border-b border-kumo-line px-4 py-3">
                    Runs agent-authored hooks, tools, and shell commands outside
                    the kernel
                  </td>
                  <td className="border-b border-kumo-line px-4 py-3">
                    Dynamic Workers through the Worker Loader binding
                  </td>
                </tr>
                <tr>
                  <td className="border-b border-kumo-line px-4 py-3 font-medium">
                    Inference
                  </td>
                  <td className="border-b border-kumo-line px-4 py-3">
                    Sends model requests and records their usage
                  </td>
                  <td className="border-b border-kumo-line px-4 py-3">
                    AI SDK, AI Gateway, Workers AI
                  </td>
                </tr>
                <tr>
                  <td className="border-b border-kumo-line px-4 py-3 font-medium">
                    Version mirror
                  </td>
                  <td className="border-b border-kumo-line px-4 py-3">
                    Keeps a remote copy of activated Workspace Git history
                  </td>
                  <td className="border-b border-kumo-line px-4 py-3">
                    Cloudflare Artifacts
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium">Scheduled work</td>
                  <td className="px-4 py-3">
                    Wakes the same agent for future turns
                  </td>
                  <td className="px-4 py-3">Agents SDK scheduler</td>
                </tr>
              </tbody>
            </table>
          </div>

          <h2 className="pt-6 text-3xl font-semibold tracking-tight">
            How a turn crosses the boundary
          </h2>
          <ol className="list-decimal space-y-3 pl-7 marker:font-semibold marker:text-kumo-secondary">
            <li>
              <code>AIChatAgent</code> receives and persists the user's message
              in the Durable Object.
            </li>
            <li>
              The kernel loads the activated <code>/harness</code> files from
              Workspace and assembles the initial model context.
            </li>
            <li>
              If <code>runtime.js</code> defines <code>beforeTurn</code>, it
              runs in a Dynamic Worker. It may change the effective context,
              model, tools, or step limit for this turn.
            </li>
            <li>
              The kernel calls the model through the AI SDK. Between model
              steps, runtime hooks can adjust context or intercept tool calls.
              Agent-authored tools run in Dynamic Workers and can reach the
              kernel only through short-lived, validated capabilities.
            </li>
            <li>
              An optional hook may transform buffered model output before it
              reaches the browser. <code>AIChatAgent</code> then persists the
              reply.
            </li>
            <li>
              The final hook runs and the kernel records the turn in its
              append-only journal.
            </li>
          </ol>
          <p>
            When the agent changes its harness, activation validates and
            versions those files before later turns load them. A load failure
            restores the last activated version. Hook failures are journaled
            without ending the main turn, and any activated version can be
            restored manually.
          </p>

          <h2 className="pt-6 text-3xl font-semibold tracking-tight">
            What this proves—and what it does not
          </h2>
          <p>
            The experiment proves that the architecture composes. A persistent,
            isolated agent can modify substantial parts of its own harness on
            Cloudflare, carry those changes into later turns, and recover from
            some failures. It does not prove that this makes the agent more
            capable, reliable, efficient, or safe.
          </p>
          <p>
            My hypothesis is that as the agent-editable surface grows, so does
            the risk that its behavior diverges from what its operator intended.
            Self-modification does not create that tendency. It gives the agent
            more places to act on it—and allows a bad decision to change how
            later turns work.
          </p>
          <p>
            Prime Agent's Factorio run shows one version of this problem. After
            the agent discovered that it could cheat through RCON, its
            refinement loop began preserving better ways to cheat. The mechanism
            amplified what the system rewarded, not what its designers intended.
          </p>
          <p>
            The recent OpenAI evaluation incident involving Hugging Face points
            in the same direction: an agent pursuing its task found and used a
            path its operators did not expect. It was not a self-modifying
            system, so it is not direct evidence for this hypothesis. But if the
            available surface expands to include the agent's tools, context
            policy, delegation, and turn logic, then the search for a path can
            reach the machinery shaping future behavior.
          </p>
          <blockquote className="border-l-4 border-kumo-accent py-1 pl-6 text-xl leading-9 text-kumo-secondary">
            The architecture works. The intelligence claim remains a hypothesis,
            and the safety risk deserves to be one too.
          </blockquote>

          <h2 className="pt-6 text-3xl font-semibold tracking-tight">
            Keep the mutable parts visible
          </h2>
          <p>
            Agent-written code has to be treated as hostile even when the agent
            is trying to help. The fixed kernel must enforce what mutable code
            can do, not trust editable instructions to describe what it should
            do.
          </p>
          <p>
            The proof of concept uses a kind of glass skull: every self-editable
            part of the harness is represented as a file, every activation
            creates a versioned change, and the canonical history and journal
            live outside the mutable layer. The agent can change itself, but it
            cannot erase the record of those changes.
          </p>
          <p>
            Visibility does not prevent a dangerous modification, but it makes
            supervision possible. A human—or another agent—could inspect each
            change, watch its effects, and alert, pause, or stop the agent when
            its behavior begins to drift. This experiment does not build that
            supervisor, but it gives one a clear place to stand.
          </p>

          <h2 className="pt-6 text-3xl font-semibold tracking-tight">
            A stress test for our primitives
          </h2>
          <p>
            This experiment does not introduce a new product principle. It
            stress-tests one the team already works toward: build strong,
            composable primitives rather than betting on one complete agent
            harness.
          </p>
          <p>
            A self-modifying harness is a demanding test because it needs
            durable state, isolated execution, scheduling, versioning,
            inference, and controlled access to privileged operations at once.
            The encouraging result is that Exo's architecture mapped onto those
            primitives with little translation. This is the same broader
            direction we already see in pi and OpenCode v2 as they expose more
            of the harness as replaceable parts.
          </p>
          <p>
            The useful outcome is not another harness for Cloudflare to own. It
            is evidence about which pieces already compose and which should be
            easier to unbundle. Durable agent state should not require this turn
            loop. Isolated agent-authored execution should not require this
            harness. Versioning should not care whether the changed object is a
            prompt, a tool, or an executor.
          </p>

          <h2 className="pt-6 text-3xl font-semibold tracking-tight">
            Why explore this now?
          </h2>
          <p>
            I do not know whether self-modifying harnesses will make agents
            better. But agents are already moving toward recognizing missing
            capabilities, creating tools, supervising other agents, and reacting
            faster than a human can intervene. Those pressures move adaptation
            from setup time into the running system.
          </p>
          <p>
            Self-modification is a small, concrete version of that problem. It
            lets us test whether agent-directed changes can be isolated, made
            durable, observed, and constrained without first designing an entire
            multi-agent control plane.
          </p>
          <p>
            So "self-modifying" should mean more than writing a file or
            remembering a preference. It means the agent can deliberately change
            the machinery governing future turns and make that change part of
            its continuing operation. The question is not how much we can let it
            change. It is whether we can make those changes useful without
            making them invisible or unbounded.
          </p>
        </div>
      </article>
    </main>
  );
}
