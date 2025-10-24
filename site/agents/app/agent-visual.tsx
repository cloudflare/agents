import {
  AnimatePresence,
  motion,
  MotionValue,
  useAnimationControls,
  useMotionValueEvent,
  useTransform
} from "framer-motion";
import {
  Chat,
  ChatMessage,
  TypedMessage,
  useSequencedMotionValues
} from "./_components/chat";
import { ReactNode, useMemo, useRef, useState } from "react";
import clsx from "clsx";

export function AgentVisual({ progress }: { progress: MotionValue<number> }) {
  const [active, setActive] = useState(false);

  const values = useSequencedMotionValues(3, progress);
  const [issueProgress, codeProgress, gitProgress] = values;

  useMotionValueEvent(progress, "change", (v: number) => {
    queueMicrotask(() => setActive(v > 0));
  });

  return (
    <div className="space-y-3 py-16">
      <Chat>
        <ChatMessage>
          <TypedMessage message="Implement and open a pull request for the first issue I have assigned to me." />
        </ChatMessage>
        <ChatMessage type="ai">
          <TypedMessage message="Sure thing!" />
          <motion.ul
            initial={{ x: 16, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            transition={{
              type: "spring",
              bounce: 0
            }}
            className="mt-2"
          >
            <ListItem progress={issueProgress}>
              <span className="md:hidden">Look at assigned issues</span>
              <span className="hidden md:inline">
                Look at issues assigned to you
              </span>
            </ListItem>
            <ListItem progress={codeProgress}>
              <span className="md:hidden">Implement code</span>
              <span className="hidden md:inline">
                Write code to implement issue
              </span>
            </ListItem>
            <ListItem progress={gitProgress}>Open pull request</ListItem>
          </motion.ul>
        </ChatMessage>
      </Chat>
      <AnimatePresence>
        {active && (
          <Window>
            <Issues progress={issueProgress} />
            <Code progress={codeProgress} />
            <PullRequest progress={gitProgress} />
          </Window>
        )}
      </AnimatePresence>
    </div>
  );
}

function PullRequest({ progress }: { progress: MotionValue<number> }) {
  const triggeredRef = useRef(false);
  const controls = useAnimationControls();
  const [active, setActive] = useState(false);
  useMotionValueEvent(progress, "change", (v: number) => {
    queueMicrotask(() => setActive(v > 0));
  });
  const values = useSequencedMotionValues(
    3,
    useTransform(progress, [0, 0.75], [0, 1])
  );

  useMotionValueEvent(progress, "change", (v: number) => {
    if (v > 0.75) {
      if (triggeredRef.current) return;
      triggeredRef.current = true;
      controls.start({ scale: 0.9 }).then(() => {
        controls.start({ scale: 1 });
      });
    } else {
      triggeredRef.current = false;
    }
  });

  return (
    <div className="absolute inset-0 pt-5">
      <AnimatePresence>
        {active && (
          <motion.div
            animate={{
              y: 0,
              opacity: 1
            }}
            initial={{
              y: 8,
              opacity: 0
            }}
            exit={{
              y: 8,
              opacity: 0
            }}
            transition={{
              type: "spring",
              stiffness: 150,
              damping: 19,
              mass: 1.2
            }}
            className="w-[150px] mx-auto space-y-2 pt-5"
          >
            <h4 className="text-sm">CF-4242</h4>
            <div className="space-y-1">
              <CodeLine progress={values[0]} width={100} />
              <CodeLine progress={values[1]} width={100} />
              <CodeLine progress={values[2]} width={50} />
            </div>
            <motion.button
              animate={controls}
              className="text-xs py-1 px-1.5 rounded-md border border-orange-400"
            >
              Ready for review
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const LINES = 8;

function Code({ progress }: { progress: MotionValue<number> }) {
  const [active, setActive] = useState(false);

  useMotionValueEvent(progress, "change", (v: number) => {
    queueMicrotask(() => setActive(v > 0 && v < 1));
  });
  const values = useSequencedMotionValues(
    LINES,
    useTransform(progress, [0, 0.75], [0, 1])
  );

  return (
    <div className="absolute inset-0 pt-5">
      <AnimatePresence>
        {active && (
          <motion.div
            exit={{ y: 8, opacity: 0 }}
            transition={{
              type: "spring",
              stiffness: 150,
              damping: 19,
              mass: 1.2
            }}
            className="w-[180px] mx-auto space-y-1 pt-5"
          >
            {Array.from({ length: LINES }).map((_, i) => {
              return <CodeLine key={i} progress={values[i]} />;
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function CodeLine({
  progress,
  width
}: {
  progress: MotionValue<number>;
  width?: number;
}) {
  const max = useMemo(() => width ?? Math.random() * 50 + 50, [width]);
  return (
    <motion.div
      className="h-4 bg-orange-100"
      style={{
        width: useTransform(progress, [0, 1], ["0%", `${max}%`])
      }}
    />
  );
}

function Issues({ progress }: { progress: MotionValue<number> }) {
  const [active, setActive] = useState(false);
  const [index, setIndex] = useState(0);

  useMotionValueEvent(progress, "change", (v: number) => {
    queueMicrotask(() => {
      setActive(v < 1);
      if (v < 0.25) setIndex(0);
      else if (v < 0.5) setIndex(1);
      else if (v < 0.75) setIndex(2);
    });
  });

  return (
    <div className="absolute inset-0 pt-5">
      <AnimatePresence>
        {active && (
          <motion.div
            animate={{
              y: 0,
              opacity: 1
            }}
            initial={{
              y: 8,
              opacity: 0
            }}
            exit={{
              y: 8,
              opacity: 0
            }}
            transition={{
              type: "spring",
              stiffness: 150,
              damping: 19,
              mass: 1.2
            }}
            className="w-[150px] mx-auto pt-4 space-y-2"
          >
            <h4 className="text-sm">Backlog</h4>
            <ul className="divide-y divide-orange-400">
              {Array.from({ length: 6 }).map((_, i) => {
                return <IssueItem key={i} active={index === i} />;
              })}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function IssueItem({ active = false }: { active?: boolean }) {
  return (
    <li
      className={clsx(
        "p-1.5 -mx-1.5 flex items-center gap-1",
        active && "bg-orange-100"
      )}
    >
      <div className="h-4 w-4 rounded-full shrink-0 border border-orange-400" />
      <div className="h-3.5 w-8 shrink-0 border border-orange-400" />
      <div className="h-3.5 grow border border-orange-400" />
    </li>
  );
}

function Window({ children }: { children: ReactNode }) {
  return (
    <div className="-mt-3">
      <motion.div
        initial={{ scaleY: 0 }}
        exit={{ scaleY: 0 }}
        style={{ originY: "top" }}
        animate={{
          scaleY: 1
        }}
        className="h-[40px] border-r border-orange-400 mx-auto w-fit"
      />
      <motion.div
        animate={{ y: 0, opacity: 1 }}
        initial={{ y: 8, opacity: 0 }}
        exit={{ y: 8, opacity: 0 }}
        transition={{
          type: "spring",
          stiffness: 150,
          damping: 19,
          mass: 1.2
        }}
        className="p-2 h-[180px] w-[250px] mx-auto rounded-lg border border-orange-400 relative overflow-hidden"
      >
        <header className="flex gap-0.5">
          <div className="border border-orange-400 rounded-full w-2.5 h-2.5" />
          <div className="border border-orange-400 rounded-full w-2.5 h-2.5" />
          <div className="border border-orange-400 rounded-full w-2.5 h-2.5" />
        </header>
        {children}
      </motion.div>
    </div>
  );
}

function ListItem({
  progress,
  children
}: {
  progress: MotionValue<number>;
  children: ReactNode;
}) {
  const strokeDashoffset = useTransform(progress, [0, 0.75], [52, 0]);
  const arrowOffset = useTransform(progress, [0.75, 1], [14, 0]);
  return (
    <li className="flex items-center gap-3">
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
            cx="10"
            cy="10"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeDasharray="52"
            r="8"
            style={{ strokeDashoffset, rotate: -90 }}
          />
          <svg width="20" viewBox="0 0 24 24" fill="none">
            <motion.path
              className="progress-check"
              d="M8 13L11 16L16 8"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray="14"
              style={{
                strokeDashoffset: arrowOffset
              }}
            />
          </svg>
        </g>
      </svg>
      <span>{children}</span>
    </li>
  );
}
