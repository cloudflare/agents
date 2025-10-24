"use client";

import { ReactNode, useEffect, useRef, useState } from "react";
import {
  AnimatePresence,
  motion,
  transform,
  useMotionValueEvent,
  useScroll,
  useTransform
} from "framer-motion";
import {
  Chat,
  ChatMessage,
  ControlledChat,
  TypedMessage
} from "./_components/chat";
import { BackgroundLines } from "./_components/background";
import { AgentVisual } from "./agent-visual";
import { ChatBubble } from "./_components/chat-bubble";

export function HeaderVisual() {
  const ref = useRef<HTMLDivElement>(null);
  const agenticRef = useRef<HTMLDivElement>(null);

  const [showBubbles, setShowBubbles] = useState(false);
  const [scrollBounds, setScrollBounds] = useState<{
    top: number;
    bottom: number;
    elementTop: number;
    elementHeight: number;
  } | null>(null);

  useEffect(() => {
    if (!ref.current || !agenticRef.current) return;
    const box = ref.current.getBoundingClientRect();
    setScrollBounds({
      top: box.top,
      bottom: box.bottom,
      elementTop: parseInt(window.getComputedStyle(agenticRef.current).top),
      elementHeight: agenticRef.current.getBoundingClientRect().height
    });
  }, []);

  const { scrollY } = useScroll({
    target: ref
  });
  const progress = useTransform(scrollY, (v: number) => {
    if (!scrollBounds) return 0;
    return transform(
      v,
      [
        scrollBounds.top - scrollBounds.elementTop,
        scrollBounds.bottom - scrollBounds.elementHeight - 500
      ],
      [0, 1]
    );
  });

  useMotionValueEvent(progress, "change", (v: number) => {
    queueMicrotask(() => setShowBubbles(v > 0.7));
  });

  return (
    <div>
      <div className="sticky top-20 h-fit hidden md:flex justify-center z-20 mb-8 mt-4">
        <div className="grid grid-cols-2 text-sm w-fit">
          <div className="p-1 pr-1.5 pl-2.5 bg-white border border-r-0 border-orange-400 rounded-l-full">
            <p>Generative</p>
          </div>
          <div>
            <div className="p-1 pl-1.5 pr-2.5 bg-orange-400 text-white border border-l-0 border-orange-400 rounded-r-full w-fit">
              <p>Agentic</p>
            </div>
          </div>
        </div>
      </div>
      <div
        ref={ref}
        className="h-[150vh] relative grid md:grid-cols-2 md:-mt-[78px]"
      >
        <div className="relative hidden md:block">
          <BackgroundLines />
          <div className="absolute bottom-0 w-full overflow-hidden h-[500px] flex flex-col items-end justify-end -space-y-3">
            <AnimatePresence>
              {showBubbles && (
                <>
                  <Bubble
                    index={0}
                    className="mr-auto"
                    pos={{ x: 64, y: -80 }}
                  />
                  <Bubble index={1} pos={{ x: 48, y: -110 }} />
                  <Bubble index={2} pos={{ x: -10, y: 10 }} />
                </>
              )}
            </AnimatePresence>
          </div>
          <VisualWrapper>
            <motion.div
              className="space-y-3"
              style={{
                y: useTransform(progress, [0, 1], [0, -400])
              }}
            >
              <Chat>
                <ChatMessage>
                  <TypedMessage message="Implement and open a pull request for the first issue I have assigned to me." />
                </ChatMessage>
                <ChatMessage type="ai" className="space-y-4">
                  <TypedMessage message="Sure thing! I can guide you through implementing the issue and opening a pull request. First, I need some details:" />
                  <ul>
                    <TypedMessage message="1. What git repository are you using?" />
                    <TypedMessage message="2. What is the issue about?" />
                    <TypedMessage message="3. What programming language is involved?" />
                  </ul>
                  <TypedMessage message="Once I have this info, I can walk you through the implementation and PR process." />
                </ChatMessage>
                <ChatMessage>
                  <TypedMessage message="I'm using a self-hosted git instance, and the implementation should be in JavaScript." />
                </ChatMessage>
              </Chat>
              <ControlledChat
                progress={progress}
                messages={[
                  {
                    text: "Got it! Since you're using a self-hosted Git instance, I'll assume you have access to the repo and can push branches directly. Here’s a step-by-step guide to implementing your assigned issue and opening a pull request:",
                    type: "ai"
                  },
                  {
                    text: "First, if you haven't cloned the repo yet, navigate to your workspace and run:",
                    type: "ai",
                    attachment: (
                      <div className="font-mono bg-orange-50 p-2 rounded-md text-sm">
                        <p>{`git clone <repo-url>`}</p>
                        <p>{`cd <repo-folder>`}</p>
                      </div>
                    )
                  },
                  {
                    text: "Next, find the issue number (let's say ISSUE-123) and create a new branch:",
                    type: "ai",
                    attachment: (
                      <div className="font-mono bg-orange-50 p-2 rounded-md text-sm">
                        <p>{`git checkout -b feature/ISSUE-123`}</p>
                      </div>
                    )
                  },
                  {
                    text: "Then, implement the fix. Make the necessary changes in your JavaScript files. If you need help writing the code, just share the issue details with me!",
                    type: "ai"
                  },
                  {
                    text: "After testing your code, stage and commit the changes and push to your remote repository:",
                    type: "ai",
                    attachment: (
                      <div className="font-mono bg-orange-50 p-2 rounded-md text-sm">
                        <p>{`git add .`}</p>
                        <p>{`git commit -m "Fix ISSUE-123: <brief description of fix>"`}</p>
                        <p>{`git push origin feature/ISSUE-123`}</p>
                      </div>
                    )
                  },
                  {
                    text: "Finally, open a pull request. Since this is a self-hosted Git instance, the PR process might vary. Please refer to the documentation for your Git instance to see how to open a pull request.",
                    type: "ai"
                  },
                  {
                    text: "If you’re using a CLI-based PR system, let me know which tool you use (e.g., GitLab CLI, Gitea CLI), and I’ll guide you accordingly. Let me know if you need help with any step or with the actual code implementation!",
                    type: "ai"
                  }
                ]}
              />
            </motion.div>
          </VisualWrapper>
          <div className="absolute bottom-0 w-full overflow-hidden h-[300px] flex flex-col justify-end -space-y-3">
            <AnimatePresence>
              {showBubbles && (
                <>
                  <Bubble index={4} pos={{ x: 16 }} />
                  <Bubble
                    index={5}
                    className="ml-auto"
                    pos={{ x: 48, y: -20 }}
                  />
                  <Bubble index={6} pos={{ x: -10, y: 24 }} />
                </>
              )}
            </AnimatePresence>
          </div>
        </div>
        <div className="relative">
          <BackgroundLines />
          <div
            className="max-w-[330px] md:max-w-[550px] px-8 sticky top-12 mx-auto h-fit max-h-screen overflow-hidden"
            ref={agenticRef}
          >
            <AgentVisual progress={progress} />
          </div>
        </div>
        <div className="border-r border-orange-400 absolute top-0 bottom-0 left-1/2 -translate-x-px hidden md:block" />
      </div>
    </div>
  );
}

function Bubble({
  pos,
  className,
  index
}: {
  pos: { x?: number; y?: number };
  className?: string;
  index: number;
}) {
  return (
    <motion.div
      animate={{
        scale: 1
      }}
      initial={{
        scale: 0
      }}
      exit={{
        scale: 0
      }}
      transition={{
        type: "spring",
        delay: index * 0.1,
        stiffness: 800,
        damping: 80,
        mass: 4
      }}
      className={className}
      style={pos}
    >
      <ChatBubble>
        <div className="space-y-1">
          <div className="bg-orange-100 h-[1em] w-[200px]" />
          <div className="bg-orange-100 h-[1em] w-[150px]" />
        </div>
      </ChatBubble>
    </motion.div>
  );
}

function VisualWrapper({ children }: { children: ReactNode }) {
  return (
    <div className="sticky top-0 mx-auto h-full max-h-screen overflow-hidden">
      <div className="absolute [&_>*:first-child]:pt-16 [&_>*:last-child]:pb-16 top-0 px-8 w-full max-w-[550px] left-1/2 -translate-x-1/2">
        {children}
      </div>
    </div>
  );
}
