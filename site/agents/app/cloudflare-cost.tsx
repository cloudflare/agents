"use client";

import { motion } from "framer-motion";
import { BackgroundDots, BackgroundLinesOnly } from "./_components/background";
import { ReactNode, useState } from "react";
import clsx from "clsx";
import { AiLogo, WorkersLogo } from "./_components/icons";

function IconCircle({
  size = 64,
  active = false,
  children
}: {
  size?: number;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      style={{ width: size }}
      className={clsx(
        "aspect-square rounded-full border border-orange-400 flex items-center justify-center relative transition-colors",
        active ? "bg-orange-400 text-white" : "bg-white text-orange-400"
      )}
    >
      <div
        className={clsx(
          "absolute -inset-2 border-dashed transition-all",
          active ? "scale-100 opacity-100" : "scale-90 opacity-0"
        )}
        style={{
          animation: "spin 5s linear infinite"
        }}
      >
        <svg viewBox="0 0 16 16" width="100%">
          <circle
            cx="8"
            cy="8"
            r="7.5"
            className="stroke-orange-400"
            fill="none"
            vectorEffect="non-scaling-stroke"
            strokeDasharray="5"
          />
        </svg>
      </div>
      <div className={clsx(active && "animate-pulse")}>{children}</div>
    </div>
  );
}

function LeftFigure({ active }: { active: "idle" | "compute" | null }) {
  return (
    <div className="hidden px-6 lg:flex items-center justify-center relative">
      <div className="absolute top-0 bottom-0 left-6 right-6">
        <BackgroundLinesOnly size={32} />
      </div>
      <div className="flex flex-col items-center">
        <div className="border-r border-orange-400 h-[25px] border-dashed" />
        <IconCircle active={active === "compute"}>
          <WorkersLogo width={40} />
        </IconCircle>
        <div className="border-r border-orange-400 h-[75px]" />
        <IconCircle size={40} active={active === "idle"}>
          <AiLogo />
        </IconCircle>
      </div>
    </div>
  );
}

export function CloudflareCost() {
  const [active, setActive] = useState<"idle" | "compute" | null>(null);

  const wallVisual = (
    <div className="flex items-center px-6 relative h-full">
      <div className="absolute top-1/2 left-6 right-6 border-b border-orange-400 border-dashed translate-y-3" />
      <RequestTimeline active={active} />
    </div>
  );

  return (
    <div className="grid md:grid-cols-[3fr_2fr] lg:grid-cols-[1fr_3fr_2fr] py-6 divide-x divide-orange-400">
      <LeftFigure active={active} />
      <div className="hidden h-full md:block">{wallVisual}</div>
      <article className="px-6">
        <h3 className="text-5xl font-semibold relative mb-8 md:mb-6">
          Only pay for
          <br />
          what you use.
        </h3>
        <div className="md:hidden border-y border-orange-400 mb-6">
          <div className="-mx-6 h-[250px] py-4">{wallVisual}</div>
        </div>
        <section className="space-y-1">
          <h4 className="font-semibold">Wall Clock Time vs. CPU Time</h4>
          <p>
            With Cloudflare Workers,{" "}
            <em>
              you only pay for{" "}
              <motion.button
                className="underline underline-offset-2 decoration-dashed"
                onHoverStart={() => setActive("compute")}
                onHoverEnd={() => setActive(null)}
              >
                CPU time
              </motion.button>
            </em>
            , or the time actually spent executing a task, as opposed to{" "}
            <motion.button
              onHoverStart={() => setActive("idle")}
              onHoverEnd={() => setActive(null)}
              className="underline underline-offset-2 decoration-dashed"
            >
              wall time
            </motion.button>
            , time waiting on I/O. When it comes to agents, your agent can often
            be blocked on external resources outside of your control, whether a
            slow API, an LLM or a human in the loop.
          </p>
        </section>
        <section className="space-y-1 mt-6 pt-6 border-t border-orange-400">
          <h4 className="font-semibold">WebSocket Hibernation</h4>
          <p>
            Many agents rely on WebSockets for communication, which require
            long-running connections. With WebSocket hibernation built into
            Durable Objects, when there's no activity, the Durable Object can
            shut down, while still maintaining the connection, resulting in
            cost-savings for you.
          </p>
        </section>
      </article>
    </div>
  );
}

// --

function RequestTimeline({ active }: { active: "idle" | "compute" | null }) {
  return (
    <>
      <div className="absolute top-0 left-1/2 w-max -translate-x-1/2 flex gap-3">
        <div className="flex items-center gap-1.5">
          <div className="w-4 h-4 border border-orange-400 rounded" />
          <p className="text-sm">CPU Time</p>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-4 h-4 border border-orange-400 rounded relative">
            <div className="absolute inset-0 text-orange-400">
              <BackgroundDots size={4} />
            </div>
          </div>
          <p className="text-sm">Wall Time</p>
        </div>
      </div>
      <div className="grid grid-cols-[24px_2fr_12px_1fr_18px] gap-y-1 grid-rows-[min-content,48px,min-content] items-end w-full gap-[2px] relative px-6">
        <motion.p
          animate={{
            opacity: active && active === "idle" ? 0.25 : 1
          }}
          className="text-sm text-center"
        >
          1ms
        </motion.p>
        <motion.div
          animate={{
            opacity: active && active === "compute" ? 0.25 : 1
          }}
          className="flex flex-col items-center"
        >
          <p className="text-sm">LLM Call</p>
          <div className="h-6 border-r border-orange-400" />
        </motion.div>
        <motion.p
          animate={{
            opacity: active && active === "idle" ? 0.25 : 1
          }}
          className="text-sm text-center col-start-3"
        >
          .5ms
        </motion.p>
        <motion.div
          animate={{
            opacity: active && active === "compute" ? 0.25 : 1
          }}
          className="flex flex-col items-center"
        >
          <p className="text-sm">API Call</p>
          <div className="h-6 border-r border-orange-400" />
        </motion.div>
        <motion.p
          animate={{
            opacity: active && active === "idle" ? 0.25 : 1
          }}
          className="text-sm text-center col-start-5"
        >
          .75ms
        </motion.p>
        <motion.div
          className="bg-white border border-orange-400 rounded h-12 row-start-2"
          animate={{
            opacity: active && active === "idle" ? 0.25 : 1
          }}
        />
        <motion.div
          className="bg-white border border-orange-400 rounded h-12 row-start-2 relative"
          animate={{
            opacity: active && active === "compute" ? 0.25 : 1
          }}
        >
          <div className="absolute inset-0 text-orange-400">
            <BackgroundDots size={8} />
          </div>
        </motion.div>
        <motion.div
          className="bg-white border border-orange-400 rounded h-12 row-start-2"
          animate={{
            opacity: active && active === "idle" ? 0.25 : 1
          }}
        />
        <motion.div
          className="bg-white border border-orange-400 rounded h-12 row-start-2 relative"
          animate={{
            opacity: active && active === "compute" ? 0.25 : 1
          }}
        >
          <div className="absolute inset-0 text-orange-400">
            <BackgroundDots size={8} />
          </div>
        </motion.div>
        <motion.div
          className="bg-white border border-orange-400 rounded h-12 row-start-2"
          animate={{
            opacity: active && active === "idle" ? 0.25 : 1
          }}
        />
        <motion.p
          animate={{
            opacity: active && active === "compute" ? 0.25 : 1
          }}
          className="text-sm text-center row-start-3 col-start-2"
        >
          500ms
        </motion.p>
        <motion.p
          animate={{
            opacity: active && active === "compute" ? 0.25 : 1
          }}
          className="text-sm text-center row-start-3 col-start-4"
        >
          250ms
        </motion.p>
      </div>
    </>
  );
}
