import { ArrowLeftIcon, BrainIcon } from "@phosphor-icons/react";

/** Placeholder Exo Harness blog post, ready for the final article copy. */
export function ExoHarnessBlogPost() {
  return (
    <main className="flex-1 overflow-y-auto bg-kumo-base">
      <article className="mx-auto max-w-[760px] px-6 py-16 sm:py-24">
        <a
          href="/"
          className="mb-12 flex w-fit items-center gap-2 text-sm font-medium text-kumo-secondary no-underline hover:text-kumo-default"
        >
          <ArrowLeftIcon size={16} />
          Back to agent
        </a>

        <header>
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-kumo-accent">
            Exo Harness
          </p>
          <h1 className="mt-5 text-4xl font-semibold leading-[1.05] tracking-[-0.04em] text-kumo-default sm:text-6xl">
            Building an agent that can rewrite itself
          </h1>
          <p className="mt-7 text-xl leading-8 text-kumo-secondary sm:text-2xl sm:leading-9">
            A placeholder introduction for the story behind Exo Harness, its
            stable kernel, and the evolvable agent running inside it.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-kumo-secondary">
            <span className="font-medium text-kumo-default">Ben Reitz</span>
            <span aria-hidden="true">·</span>
            <time dateTime="2026-08-26">August 26, 2026</time>
            <span aria-hidden="true">·</span>
            <span>5 min read</span>
          </div>
        </header>

        <figure
          className="mt-12 flex aspect-[16/9] items-center justify-center overflow-hidden rounded-2xl text-white"
          style={{
            background:
              "radial-gradient(circle at 30% 25%, #f6821f 0, transparent 34%), radial-gradient(circle at 70% 70%, #7c3aed 0, transparent 38%), #111827"
          }}
        >
          <div className="flex flex-col items-center gap-4">
            <BrainIcon size={64} weight="duotone" />
            <span className="text-sm font-medium uppercase tracking-[0.18em]">
              Hero image placeholder
            </span>
          </div>
        </figure>

        <div className="mt-14 space-y-7 text-lg leading-8 text-kumo-default">
          <p className="text-xl leading-9">
            This opening section should set up the problem and explain why a
            self-modifying agent is worth exploring. Replace this text with the
            final introduction when the post is ready.
          </p>

          <h2 className="pt-6 text-3xl font-semibold tracking-tight">
            Start with the problem
          </h2>
          <p>
            Describe what conventional agents make difficult, what the
            experiment set out to learn, and the constraints that shaped the
            design. Keep the framing concrete before introducing the
            architecture.
          </p>

          <h2 className="pt-6 text-3xl font-semibold tracking-tight">
            Explain how it works
          </h2>
          <p>
            Walk through the stable kernel, the editable harness, and the
            boundary between them. This is a good place for an architecture
            diagram, code sample, or a short example of the agent changing its
            own behavior.
          </p>

          <blockquote className="border-l-4 border-kumo-accent py-1 pl-6 text-xl leading-9 text-kumo-secondary">
            Add a concise statement here that captures the central idea of the
            post.
          </blockquote>

          <h2 className="pt-6 text-3xl font-semibold tracking-tight">
            Share what we learned
          </h2>
          <p>
            Close with the most useful lessons, the open questions, and what
            comes next for the experiment. Replace every placeholder in this
            template before publishing the final post.
          </p>
        </div>
      </article>
    </main>
  );
}
