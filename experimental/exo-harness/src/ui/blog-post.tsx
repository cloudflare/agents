import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon
} from "@phosphor-icons/react";

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
            An <strong>agent harness</strong> is the software around a model
            that decides what it sees, what it can do, how a turn continues, and
            what survives into the next turn. The model produces tokens, then
            the harness turns those tokens into a continuing agent.
          </p>
          <p>
            A <strong>self-modifying agent</strong> can change some, or all, of
            that machinery for future turns. Most agents can update memory or
            write files, so this has lead to the question of where those changes
            should stop. What can the agent rewrite, and what must remain fixed?
          </p>
          <p>
            A few different harnesses have emerged recently claiming to allow
            full self-modifying agents. The simplest way to compare these
            systems is to look at what the agent can change and what it cannot.
            Who makes the change matters too; a harness can be deeply
            customizable for its human without being self-modifying for the
            agent.
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
            human operating pi. The model helps write them, but it still works
            through a harness configured by a human. Self-modification means the
            agent changing its harness as part of its own continuing operation.
          </p>

          <h2 className="pt-6 text-3xl font-semibold tracking-tight">
            Prime Agent - what is an "RLM Runtime"?
          </h2>
          <p>
            <strong>
              <a
                href="https://github.com/PrimeIntellect-ai/prime-agent"
                className="underline underline-offset-4"
              >
                Prime Agent
              </a>
            </strong>{" "}
            can self-modify in three different ways, although most of the
            language they use is marketing. There's nothing particularly
            revolutionary about what the harness is doing, apart from the fact
            that there is a consistent Python session (the{" "}
            <strong>"RLM Runtime"</strong>) that is exposed to the agent as its
            one tool.
          </p>
          <p>It can use that Python session to:</p>
          <ul className="list-disc space-y-3 pl-7 marker:text-kumo-secondary">
            <li>
              Build up a long-lived Python namespace (variables and functions
              etc.) and work with files and commands.
            </li>
            <li>
              Update the narrow JSON store containing prompts, memories, skill
              descriptions, and subagent definitions, including previous
              versions of those (this is called the{" "}
              <strong>"Continual Harness"</strong>).
            </li>
            <li>
              Create ordinary Pi skills and extensions (yes - it's built on top
              of Pi), which use Pi's normal loading and reload mechanisms.
            </li>
          </ul>
          <p>
            So Prime Agent isn't as structured or limited as a traditional
            coding harness, but its Continual Harness is narrow on purpose. The
            TypeScript host still owns the agent loop, provider calls,
            transcript persistence, scheduling, and child-agent lifecycle.
          </p>

          <h2 className="pt-6 text-3xl font-semibold tracking-tight">
            Exo makes the executor replaceable
          </h2>
          <p>
            <a
              href="https://github.com/exoharness/exo"
              className="underline underline-offset-4"
            >
              Exo
            </a>
            ,{" "}
            <a
              href="https://x.com/AlexKrentsel/status/2077786601418322344"
              className="underline underline-offset-4"
            >
              announced on X
            </a>{" "}
            a few weeks ago by Alex Krentsel, a senior researcher at Google,
            separates a stable "<code>exoharness</code>" from a replaceable
            executor. The stable layer owns identity, append-only history,
            artifacts, secrets, and sandbox lifecycle. The executor owns prompt
            assembly, model calls, tool dispatch, memory, compaction, and the
            turn loop. That executor can be edited or replaced as a whole.
          </p>
          <p>
            This moves the boundary deeper than Prime Agent's persistent Python
            environment or Continual Harness. Exo can run an RLM executor, but
            it doesn't have to. The main difference here is that durable state
            lives separately from the code that uses it.
          </p>

          <h2 className="pt-6 text-3xl font-semibold tracking-tight">
            Building the same split from Cloudflare primitives
          </h2>
          <p>
            To me, Exo's separation looked like it could be native to
            Cloudflare. Durable identity and state map to Agents and Durable
            Objects. A mutable filesystem maps to Workspace. Isolated code
            execution maps to Dynamic Workers. Scheduling, version history,
            inference accounting, and remote artifacts already exist as separate
            platform capabilities.
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
                    Editable execution
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
            What does a turn look like?
          </h2>
          <div className="overflow-x-auto py-2">
            <ol className="grid min-w-[680px] grid-cols-3 gap-x-12 gap-y-12 text-base leading-7">
              <li className="relative col-start-1 row-start-1 rounded-xl border border-kumo-line bg-kumo-elevated p-5">
                <span className="mb-3 flex size-7 items-center justify-center rounded-full bg-kumo-accent text-sm font-semibold text-kumo-inverse">
                  1
                </span>
                <code>AIChatAgent</code> receives and saves the user's message
                in the Durable Object.
                <span
                  aria-hidden="true"
                  className="absolute left-full top-1/2 flex w-12 -translate-y-1/2 justify-center text-kumo-secondary"
                >
                  <ArrowRightIcon size={20} />
                </span>
              </li>
              <li className="relative col-start-2 row-start-1 rounded-xl border border-kumo-line bg-kumo-elevated p-5">
                <span className="mb-3 flex size-7 items-center justify-center rounded-full bg-kumo-accent text-sm font-semibold text-kumo-inverse">
                  2
                </span>
                The kernel loads the activated <code>/harness</code> files from
                Workspace and assembles the initial model context.
                <span
                  aria-hidden="true"
                  className="absolute left-full top-1/2 flex w-12 -translate-y-1/2 justify-center text-kumo-secondary"
                >
                  <ArrowRightIcon size={20} />
                </span>
              </li>
              <li className="relative col-start-3 row-start-1 rounded-xl border border-kumo-line bg-kumo-elevated p-5">
                <span className="mb-3 flex size-7 items-center justify-center rounded-full bg-kumo-accent text-sm font-semibold text-kumo-inverse">
                  3
                </span>
                If <code>runtime.js</code> defines <code>beforeTurn</code>, it
                runs in a Dynamic Worker. It may change the effective context,
                model, tools, or step limit for this turn.
                <span
                  aria-hidden="true"
                  className="absolute left-1/2 top-full flex h-12 -translate-x-1/2 items-center text-kumo-secondary"
                >
                  <ArrowDownIcon size={20} />
                </span>
              </li>
              <li className="relative col-start-3 row-start-2 rounded-xl border border-kumo-line bg-kumo-elevated p-5">
                <span className="mb-3 flex size-7 items-center justify-center rounded-full bg-kumo-accent text-sm font-semibold text-kumo-inverse">
                  4
                </span>
                The kernel calls the model through the AI SDK. Between model
                steps, runtime hooks can adjust context or intercept tool calls.
                Agent-authored tools run in Dynamic Workers and can reach the
                kernel only through short-lived, validated capabilities.
                <span
                  aria-hidden="true"
                  className="absolute right-full top-1/2 flex w-12 -translate-y-1/2 justify-center text-kumo-secondary"
                >
                  <ArrowLeftIcon size={20} />
                </span>
              </li>
              <li className="relative col-start-2 row-start-2 rounded-xl border border-kumo-line bg-kumo-elevated p-5">
                <span className="mb-3 flex size-7 items-center justify-center rounded-full bg-kumo-accent text-sm font-semibold text-kumo-inverse">
                  5
                </span>
                An optional hook may transform buffered model output before it
                reaches the browser. <code>AIChatAgent</code> then persists the
                reply.
                <span
                  aria-hidden="true"
                  className="absolute right-full top-1/2 flex w-12 -translate-y-1/2 justify-center text-kumo-secondary"
                >
                  <ArrowLeftIcon size={20} />
                </span>
              </li>
              <li className="relative col-start-1 row-start-2 rounded-xl border border-kumo-line bg-kumo-elevated p-5">
                <span className="mb-3 flex size-7 items-center justify-center rounded-full bg-kumo-accent text-sm font-semibold text-kumo-inverse">
                  6
                </span>
                The final hook runs and the kernel records the turn in its
                append-only journal.
                <span
                  aria-hidden="true"
                  className="absolute bottom-full left-1/2 flex h-12 -translate-x-1/2 items-center gap-1 whitespace-nowrap text-xs font-semibold text-kumo-secondary"
                >
                  <ArrowUpIcon size={20} />
                  Next turn
                </span>
              </li>
            </ol>
          </div>
          <p>
            When the agent changes its harness (the files in the workspace),
            activation validates and versions those files before later turns
            load them. A load failure restores the last activated version. Hook
            failures are journaled without ending the main turn, and any
            activated version can be restored manually.
          </p>

          <h2 className="pt-6 text-3xl font-semibold tracking-tight">
            What this proves (and what it does not)
          </h2>
          <p>
            The experiment proves out what we already know - our architecture is
            composable. A persistent, isolated agent can modify large parts of
            its own harness on Cloudflare, carry those changes into later turns,
            and recover from some failures. What I still don't know after all
            this is whether the self-modifying agent is actually more capable,
            reliable, efficient, or safe.
          </p>
          <p>
            My hypothesis is that as the agent-editable surface grows, so does
            the risk that its behavior diverges from what its human intended.
            Self-modification doesn't create that tendency itself, but it does
            give the agent more places to mis-align its own behaviour. In a best
            case scenario, any slightly wrong decision can make its outcomes
            worse. In a worst case scenario, it can completely break itself, or
            turn itself into an agent of evil through prompt injection or
            gradual mis-alignment over time.
          </p>
          <p>
            <a
              href="https://www.primeintellect.ai/blog/prime-agent#:~:text=MODE%20kernel%20leaderboard.-,A%20long%2Dhorizon%20case%20study%20on%20games,-Autonomously%20playing%20video"
              className="underline underline-offset-4"
            >
              Prime Agent's Factorio run
            </a>
            shows one version of this problem. After the agent discovered that
            it could cheat through RCON, its refinement loop began preserving
            better ways to cheat. The mechanism amplified what the system
            rewarded, not what its human creators intended.
          </p>
          <p>
            <a
              href="https://openai.com/index/hugging-face-model-evaluation-security-incident/"
              className="underline underline-offset-4"
            >
              The recent OpenAI security incident
            </a>{" "}
            also points in the same direction: an agent pursuing its task found
            and used a path its humans didn't expect. It wasn't a self-modifying
            system, so it is not direct evidence for this hypothesis. But I
            imagine if the available surface expands to include the agent's own
            tools, context policy, delegation, and turn logic, the search for
            shortcuts will involve changes to the layer that shapes all of its
            future behavior. The agent's pressure to optimise would apply not
            just to external actions but to its own decision-making process.
          </p>

          <h2 className="pt-6 text-3xl font-semibold tracking-tight">
            Keep the mutable parts visible
          </h2>
          <p>
            Agent-written code has to be treated as hostile even when the agent
            is trying to help. The kernel has to enforce limits rather than just
            trusting the agent to follow them.
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
            supervision possible. A human (or much more likely, an agent) could
            inspect each change, watch its effects, and alert, pause, or stop
            the agent when its behavior begins to drift. This experiment does
            not build that supervisor, but it gives one a clear place to stand
            and watch.
          </p>

          <h2 className="pt-6 text-3xl font-semibold tracking-tight">
            A stress test for our primitives
          </h2>
          <p>
            There's nothing really new being stress-tested by this experiment.
            It just turns out that it clarifies that the one the team is already
            works towards is important: build strong, composable primitives
            rather than betting on one complete agent harness.
          </p>
          <p>
            A self-modifying harness is a hard test because it needs durable
            state, isolated execution, scheduling, versioning, inference, and
            controlled access to privileged operations at once. The encouraging
            result for me is that Exo's architecture mapped onto those
            primitives with little translation. This is the same broader
            direction we already see in Pi and OpenCode's next major releases as
            they expose more of the harness as replaceable parts.
          </p>
          <p>
            Durable agent state should not require this turn loop. Isolated
            agent-authored execution should not require this harness. Versioning
            should not care whether the changed object is a prompt, a tool, or
            an executor.
          </p>

          <h2 className="pt-6 text-3xl font-semibold tracking-tight">
            Why explore this now?
          </h2>
          <p>
            Honestly, this hasn't made it any clearer to me as to whether
            self-modifying harnesses will make agents better; it feels like the
            noise around RLM and Prime Agent has died down since it was
            announced and I never really saw any clear evidence to say that RLM
            agents get better results than more classic harnesses.
          </p>
          <p>
            But inference is getting quicker and quicker, and as agents are
            getting more capabilities for building their own tools, we need to
            start allowing them to supervise and monitor each other as they're
            too fast for humans to keep an eye on them. We need to allow agents
            to adapt during runtime rather than during setup.
          </p>
          <p>
            Self-modification might turn out to be mostly hype. Even if that is
            the case, this experiment made a few things extra clear to me: if an
            agent can rewrite itself, it needs to do so inside a glass skull.
            Every editable part should be visible, every change should leave a
            record, and the authority to watch it or stop it should remain
            outside the agent.
          </p>
          <p>
            Having said all that, I don't really know what it looks like to have
            a system of agents where each one has another agent watching its
            every move and holding a gun to its glass skull in case it steps out
            of line. Do we need some kind of agent orchestrator? Some kind of
            agent control plane?
          </p>
          <p className="text-xl leading-9">
            Flue already gives us the ability to build agents like we would
            build React components. Now how do we compose those agents into a
            full React app?
          </p>
        </div>
      </article>
    </main>
  );
}
