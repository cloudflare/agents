import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import { motion, useInView } from "framer-motion";
import { BackgroundDots, BackgroundLinesOnly } from "./_components/background";
import { useTypedMessage } from "./_components/chat";
import clsx from "clsx";
import { gsap, useGSAP } from "./gsap";
import { ChatBubble } from "./_components/chat-bubble";

export function AgentsIntro() {
  const [cancelled, setCancelled] = useState(false);
  return (
    <section className="grid md:grid-cols-2 lg:grid-cols-3 py-6">
      <article className="mx-6 md:pr-6 md:mr-0 leading-relaxed mb-6 pb-6 border-b border-orange-400 md:mb-0 md:pb-0 md:border-b-0 md:border-r">
        <h2 className="text-5xl font-semibold mb-6">What are agents?</h2>
        <p>
          Agentic AI goes beyond traditional generative AI by integrating
          autonomy, goal-directed reasoning, and adaptive decision-making.
          Unlike standard generative models, which passively respond to prompts,
          agentic AI actively plans, iterates, and interacts with its
          environment to achieve complex objectives.
        </p>
      </article>
      <figure className="h-[520px] relative px-6 lg:border-r border-orange-400">
        <div className="absolute left-6 right-6 top-0 bottom-0 text-orange-400">
          <BackgroundLinesOnly />
        </div>
        <AgentsVisualBacklog onComplete={() => setCancelled(true)} />
      </figure>
      <figure className="relative px-6 -mb-6 hidden lg:block">
        <BacklogList cancelled={cancelled} />
      </figure>
    </section>
  );
}

function BacklogList({ cancelled = false }: { cancelled?: boolean }) {
  return (
    <div className="flex flex-col gap-1 h-[550px] overflow-hidden">
      <h3>Backlog</h3>
      <ul className="divide-y divide-orange-400">
        <li className="flex gap-3 py-1">
          <p className="font-mono">CF-4242</p>
          <p>Ship AI Agents</p>
          <p className="ml-auto">1 day ago</p>
        </li>
        {Array.from({ length: 16 }).map((_, i) => {
          return <BacklogItem cancelled={cancelled} delay={i * 0.02} key={i} />;
        })}
      </ul>
    </div>
  );
}

function BacklogItem({
  cancelled = false,
  delay = 0
}: {
  cancelled?: boolean;
  delay?: number;
}) {
  return (
    <li className="py-1 relative">
      <div
        className={clsx(
          "flex gap-3 transition-opacity",
          cancelled && "opacity-30"
        )}
        style={{ transitionDelay: `${delay}s` }}
      >
        <p className="font-mono">CF-1111</p>
        <p>Fix the bug</p>
        <p className="ml-auto">3 months ago</p>
      </div>
      <div
        className={clsx(
          "absolute left-0 right-0 border-b border-orange-400 top-1/2 origin-left transition-transform duration-500",
          cancelled ? "scale-x-100" : "scale-x-0"
        )}
        style={{ transitionDelay: `${delay}s` }}
      />
    </li>
  );
}

function AgentsVisualBacklog({ onComplete }: { onComplete?: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  const isVisible = useInView(container, { amount: 0.8, once: true });
  const tl = useRef<gsap.core.Timeline>(null);
  const [showList, setShowList] = useState(false);

  /* useGSAP(
    () => {
      const issueTl = gsap
        .timeline()
        .fromTo(
          "#issues",
          {
            scale: 0,
            opacity: 1,
            svgOrigin: "100 90",
            ease: "elastic.out(1,1)",
          },
          {
            scale: 1,
          }
        )
        .to(
          "#issue-path",
          {
            strokeDashoffset: 0,
          },
          "<0.3"
        );
      const globalTl = gsap
        .timeline({
          paused: true,
          onComplete: () => {
            gsap.to("li:nth-child(3) .progress-check", {
              strokeDashoffset: 0,
            });
            onComplete?.();
          },
        })
        .to("li:first-child .progress", {
          strokeDashoffset: 0,
          duration: issueTl.totalDuration(),
        });
      globalTl.add(issueTl, "<");
      const bugTl = gsap
        .timeline()
        .fromTo(
          "#bug",
          {
            scale: 0,
            opacity: 1,
            svgOrigin: "125 90",
            ease: "elastic.out(1,1)",
          },
          {
            scale: 1,
          }
        )
        .to(
          "#bug-path",
          {
            strokeDashoffset: 0,
          },
          "<0.3"
        )
        .set("#bug-progress", { opacity: 1 })
        .to("#bug-progress", {
          attr: {
            cx: 100,
            cy: -5,
          },
        });
      globalTl.add(
        gsap.to("#issues", {
          x: -35,
        })
      );
      globalTl.add(
        gsap.to("li:first-child .progress-check", {
          strokeDashoffset: 0,
        }),
        "<"
      );
      globalTl.add(
        gsap.to("#issue-path", {
          attr: {
            d: "M 100 -5 L 65 90",
          },
        }),
        "<"
      );
      globalTl.add(
        gsap.to("li:nth-child(2) .progress", {
          strokeDashoffset: 0,
          duration: bugTl.totalDuration(),
        }),
        "<"
      );
      globalTl.add(bugTl, "<");
      globalTl.add(
        gsap.to("li:nth-child(2) .progress-check", {
          strokeDashoffset: 0,
        })
      );

      const cancelTl = gsap
        .timeline()
        .to("#issue-progress", {
          attr: {
            cx: 65,
            cy: 90,
          },
        })
        .to("#issue-progress", {
          attr: {
            cx: 100,
            cy: -5,
          },
        });
      globalTl.add(
        gsap.to("li:nth-child(3) .progress", {
          strokeDashoffset: 0,
          duration: cancelTl.totalDuration(),
        }),
        "<"
      );
      globalTl.add(cancelTl, "<");
      tl.current = globalTl;
    },
    { scope: container }
  ); */

  const agent = useTypedMessage("Sure thing.", {
    onDone: useCallback(() => {
      setTimeout(() => {
        setShowList(true);
        setTimeout(() => onComplete?.(), 3000);
      }, 100);
    }, [])
  });
  const msg = useTypedMessage(
    "Clean up our backlog, cancelling any issues that are no longer relevant.",
    {
      onDone: useCallback(() => agent.start(), [])
    }
  );

  useEffect(() => {
    if (isVisible) msg.start();
  }, [isVisible]);

  return (
    <div
      ref={container}
      className="relative flex flex-col items-center h-full gap-4 px-10 justify-center"
    >
      <ChatBubble arrowPosition="right">{msg.visibleMessage}</ChatBubble>
      <ChatBubble
        arrowPosition="left"
        style={{ opacity: agent.visibleMessage ? 1 : 0, zIndex: 20 }}
      >
        <div className="overflow-hidden relative">
          <p>{agent.visibleMessage}</p>
          {showList && (
            <motion.ul
              className="space-y-1 mt-2"
              animate={{ opacity: 1, x: 0 }}
              initial={{ opacity: 0, x: -24 }}
              transition={{ type: "spring", bounce: 0 }}
            >
              <ListItem>Find all issues in backlog</ListItem>
              <ListItem delay={1}>Check recent bug reports</ListItem>
              <ListItem delay={2}>Cancel irrelevant issues</ListItem>
            </motion.ul>
          )}
        </div>
      </ChatBubble>
      {showList && (
        <motion.ul className="flex gap-3 mt-6 relative">
          <div
            className="absolute bottom-6 left-6 border-b border-orange-400 w-1/2"
            style={{
              transformOrigin: "left",
              rotate: "-60deg"
            }}
          />
          <div
            className="absolute bottom-6 right-6 border-b border-orange-400 w-1/2"
            style={{
              transformOrigin: "right",
              rotate: "60deg"
            }}
          />
          <ExternalItem>
            <FileIcon />
          </ExternalItem>
          <Arrow />
          <ExternalItem delay={0.1} progressDelay={1}>
            <svg
              width="32"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeLinejoin="round"
              x="135"
              y="90"
            >
              <path
                vectorEffect="non-scaling-stroke"
                d="M4.75 6.75C4.75 5.64543 5.64543 4.75 6.75 4.75H17.25C18.3546 4.75 19.25 5.64543 19.25 6.75V17.25C19.25 18.3546 18.3546 19.25 17.25 19.25H6.75C5.64543 19.25 4.75 18.3546 4.75 17.25V6.75Z"
              />
              <path d="M8.75 15.25V9.75" strokeWidth="1.5" />
              <path d="M15.25 15.25V9.75" strokeWidth="1.5" />
              <path d="M12 15.25V12.75" strokeWidth="1.5" />
            </svg>
          </ExternalItem>
          <Arrow />
          <ExternalItem delay={0.2} progressDelay={2}>
            <FileIcon />
          </ExternalItem>
        </motion.ul>
      )}
      {/* <ExternalRequests /> */}
    </div>
  );
}

function Arrow() {
  return (
    <svg
      viewBox="0 0 36 32"
      width="36"
      className="text-orange-400"
      stroke="currentColor"
    >
      <path d="M 0 16 H 36" />
      <g transform="translate(36 16)">
        <path d="M -8 -8 L 0 0 L -8 8" fill="none" />
      </g>
    </svg>
  );
}

function ExternalItem({
  delay = 0,
  progressDelay = 0,
  children
}: {
  children: ReactNode;
  delay?: number;
  progressDelay?: number;
}) {
  return (
    <motion.li
      animate={{ scale: 1 }}
      initial={{ scale: 0 }}
      transition={{
        type: "spring",
        delay,
        stiffness: 800,
        damping: 80,
        mass: 4
      }}
      className="relative"
    >
      <div className="absolute -inset-1">
        <svg width="100%" viewBox="0 0 100 100">
          <motion.circle
            cx="50"
            cy="50"
            r="42"
            fill="none"
            className="stroke-orange-300"
            strokeWidth="10"
            strokeDasharray="264"
            strokeDashoffset="264"
            style={{ rotate: -90 }}
            animate={{ strokeDashoffset: 0 }}
            transition={{ type: "tween", duration: 1, delay: progressDelay }}
          />
        </svg>
      </div>
      <div className="w-12 h-12 border border-orange-400 rounded-full items-center justify-center flex relative bg-white text-orange-400">
        {children}
      </div>
    </motion.li>
  );
}

function FileIcon() {
  return (
    <svg
      width="32"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      x="100"
      y="90"
    >
      <path
        d="M7.75 19.25H16.25C17.3546 19.25 18.25 18.3546 18.25 17.25V9L14 4.75H7.75C6.64543 4.75 5.75 5.64543 5.75 6.75V17.25C5.75 18.3546 6.64543 19.25 7.75 19.25Z"
        vectorEffect="non-scaling-stroke"
      />
      <path d="M18 9.25H13.75V5" vectorEffect="non-scaling-stroke" />
      <path d="M9.75 15.25H14.25" vectorEffect="non-scaling-stroke" />
      <path d="M9.75 12.25H14.25" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function ExternalRequests() {
  return (
    <svg viewBox="0 0 200 110" width="100%" className="-mt-4 stroke-orange-400">
      <g>
        <path
          id="issue-path"
          d="M 100 -5 L 100 90"
          vectorEffect="non-scaling-stroke"
          pathLength="10"
          strokeDasharray="18"
          strokeDashoffset="18"
        />
        <g id="issues" opacity="0">
          <circle
            cx="100"
            cy="90"
            r="15"
            fill="white"
            vectorEffect="non-scaling-stroke"
          />
          <g transform="translate(-11.5 -12)">
            <FileIcon />
          </g>
        </g>
      </g>
      <g>
        <path
          id="bug-path"
          d="M 100 -5 L 135 90"
          vectorEffect="non-scaling-stroke"
          pathLength="10"
          strokeDasharray="18"
          strokeDashoffset="18"
        />
        <circle
          id="bug-progress"
          cx="135"
          cy="90"
          r="3"
          fill="white"
          vectorEffect="non-scaling-stroke"
          style={{ opacity: 0 }}
        />
        <g id="bug" opacity="0">
          <circle
            cx="135"
            cy="90"
            r="15"
            fill="white"
            vectorEffect="non-scaling-stroke"
          />
          <g transform="translate(-11.5 -12)">
            <svg
              width="24"
              height="24"
              fill="none"
              viewBox="0 0 24 24"
              className="text-orange-400"
              stroke="currentColor"
              strokeLinejoin="round"
              x="135"
              y="90"
            >
              <path
                vectorEffect="non-scaling-stroke"
                d="M4.75 6.75C4.75 5.64543 5.64543 4.75 6.75 4.75H17.25C18.3546 4.75 19.25 5.64543 19.25 6.75V17.25C19.25 18.3546 18.3546 19.25 17.25 19.25H6.75C5.64543 19.25 4.75 18.3546 4.75 17.25V6.75Z"
              />
              <path d="M8.75 15.25V9.75" strokeWidth="1.5" />
              <path d="M15.25 15.25V9.75" strokeWidth="1.5" />
              <path d="M12 15.25V12.75" strokeWidth="1.5" />
            </svg>
          </g>
        </g>
      </g>
    </svg>
  );
}

function ListItem({
  children,
  delay = 0
}: {
  children: ReactNode;
  delay?: number;
}) {
  return (
    <li className="flex items-center gap-2 leading-tight">
      <svg viewBox="0 0 20 20" width="20">
        <circle
          className="text-orange-200"
          cx="10"
          cy="10"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray="3"
          r="8"
        />
        <g className="text-orange-400">
          <motion.circle
            animate={{ strokeDashoffset: 0 }}
            transition={{ type: "tween", duration: 1, delay }}
            cx="10"
            cy="10"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeDasharray="52"
            strokeDashoffset="52"
            r="8"
            transform="rotate(-90 10 10)"
          />
          <svg width="20" viewBox="0 0 24 24" fill="none">
            <motion.path
              animate={{ strokeDashoffset: 0 }}
              transition={{ delay: 1 + delay }}
              d="M8 13L11 16L16 8"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray="14"
              strokeDashoffset="14"
            />
          </svg>
        </g>
      </svg>
      {children}
    </li>
  );
}
