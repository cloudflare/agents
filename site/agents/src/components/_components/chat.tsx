import {
  Children,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from "react";
import {
  AnimatePresence,
  motion,
  motionValue,
  MotionValue,
  transform,
  useMotionValueEvent,
  useTransform
} from "framer-motion";
import { ChatArrow } from "./chat-bubble";
import clsx from "clsx";

import useInterval from "../use-interval";

const ChatContext = createContext<{
  next: () => void;
} | null>(null);

export function Chat({ children }: { children: ReactNode }) {
  const [index, setIndex] = useState(0);
  const childArr = Children.toArray(children);
  const visibleMessages = childArr.slice(0, index + 1);

  return (
    <ChatContext.Provider
      value={{
        next: useCallback(() => {
          setIndex((i) => i + 1);
        }, [])
      }}
    >
      {visibleMessages}
    </ChatContext.Provider>
  );
}

/**
 * Given a motion value `progress` that ranges from 0 -> 1 and a `count`,
 * creates `count` motion values that will run in sequence as `progress`
 * changes.
 *
 * For example, given `length = 3`, this will return 3 motion values:
 *   - The first motion value will be 1 when `progress` is `0.33`
 *   - The second motion value will be 1 when `progress` is `0.67`
 *   - The third motion value will be 1 when `progress` is 1
 */
export function useSequencedMotionValues(
  length: number,
  progress: MotionValue<number>
) {
  const values = useMemo(() => {
    return Array.from({ length }).map(() => {
      return motionValue(0);
    });
  }, [length]);
  const gap = 1 / length;
  useMotionValueEvent(progress, "change", (scrollProgress: number) => {
    /**
     * The 0 -> 1 should be split based on the # of messages
     */
    values.forEach((value, index) => {
      const min = gap * index;
      const max = gap * (index + 1);
      value.set(transform(scrollProgress, [min, max], [0, 1]));
    });
  });
  return values;
}

export function ControlledChat({
  messages,
  progress
}: {
  messages: {
    text: string;
    type?: "user" | "ai";
    attachment?: ReactNode;
  }[];
  progress: MotionValue<number>;
}) {
  const [index, setIndex] = useState(0);

  const indexReal = useTransform(progress, [0, 1], [0, messages.length]);
  const indexRounded = useTransform(indexReal, (i: number) => {
    if (i <= 0) return -1;
    return Math.round(i);
  });
  useMotionValueEvent(indexRounded, "change", (v: number) =>
    queueMicrotask(() => setIndex(v))
  );

  const progresses = useSequencedMotionValues(messages.length, progress);
  return (
    <>
      {messages.slice(0, index + 1).map((m, i) => {
        return (
          <ControlledTypedMessage
            key={i}
            message={m.text}
            type={m.type ?? "user"}
            progress={progresses[i]}
          >
            {m.attachment}
          </ControlledTypedMessage>
        );
      })}
    </>
  );
}

export const useChatContext = () => {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("Must be used in a ChatContext");
  return ctx;
};

const ChatMessageContext = createContext<{
  index: number;
  next: () => void;
  type: "user" | "ai";
} | null>(null);

export const useChatMessageContext = () => {
  const ctx = useContext(ChatMessageContext);
  if (!ctx) throw new Error("Not used in ChatMessageContext");
  return ctx;
};

export function ChatMessage({
  children,
  className,
  type = "user",
  delay = 300
}: {
  children: ReactNode;
  className?: string;
  type?: "user" | "ai";
  delay?: number;
}) {
  const { next } = useChatContext();
  const [index, setIndex] = useState(0);
  const childArr = Children.toArray(children);
  const visibleMessages = childArr.slice(0, index);

  useEffect(() => {
    if (index > childArr.length) {
      next();
    }
  }, [index, childArr.length, next]);

  useEffect(() => {
    const t = setTimeout(() => setIndex(index + 1), delay);
    return () => clearTimeout(t);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- index intentionally excluded to avoid infinite loop
  }, [delay]);

  return (
    <motion.div
      className="relative"
      initial={{ x: type === "ai" ? -16 : 16, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{
        type: "spring",
        bounce: 0
      }}
    >
      <div
        className={clsx(
          "p-6 border border-orange-400 rounded-2xl bg-white min-h-[74px]",
          type === "ai" ? "md:mr-10" : "md:ml-10",
          className
        )}
      >
        <ChatMessageContext.Provider
          value={{
            index,
            next: useCallback(() => setIndex((i) => i + 1), []),
            type
          }}
        >
          {visibleMessages}
        </ChatMessageContext.Provider>
      </div>
      <ChatArrow position={type === "ai" ? "left" : "right"} />
    </motion.div>
  );
}

export function useTypedMessage(
  message: string,
  {
    speed = 20,
    onDone
  }: {
    speed?: number;
    onDone?: () => void;
  } = {}
) {
  const [playing, setPlaying] = useState(false);
  const [index, setIndex] = useState(0);

  const visibleMessage = message.slice(0, index);
  const finished = index > message.length;

  useEffect(() => {
    if (index > message.length) {
      setPlaying(false);
      onDone?.();
    }
  }, [index, message, onDone]);

  useInterval(
    () => {
      setIndex(index + 1);
    },
    playing ? speed : null
  );

  return {
    visibleMessage,
    start: () => {
      if (finished) {
        setIndex(0);
      }
      setPlaying(true);
    },
    pause: () => setPlaying(false),
    stop: () => {
      setPlaying(false);
      setIndex(0);
    }
  };
}

export function useControlledTypedMessage(
  message: string,
  progress: MotionValue<number>
) {
  const indexReal = useTransform(progress, [0, 1], [0, message.length]);
  const index = useTransform(indexReal, (i: number) => Math.round(i));
  const visibleMessage = useTransform(index, (i: number) =>
    message.slice(0, i)
  );
  return visibleMessage;
}

export function ControlledTypedMessage({
  message,
  progress,
  type = "user",
  children
}: {
  message: string;
  progress: MotionValue<number>;
  type?: "user" | "ai";
  children?: ReactNode;
}) {
  const [active, setActive] = useState(false);
  const [done, setDone] = useState(false);
  const msg = useControlledTypedMessage(message, progress);

  useMotionValueEvent(progress, "change", (v: number) => {
    queueMicrotask(() => {
      setActive(v > 0);
      setDone(v >= 0.9);
    });
  });

  return (
    <motion.div
      animate={{
        x: active ? 0 : type === "ai" ? -8 : 8,
        opacity: active ? 1 : 0
      }}
      initial={{
        x: type === "ai" ? -8 : 8,
        opacity: 0
      }}
      transition={{
        type: "spring",
        stiffness: 150,
        damping: 19,
        mass: 1.2
      }}
      className="relative"
    >
      <div
        className={clsx(
          "p-6 border border-orange-400 rounded-2xl bg-white min-h-[74px] space-y-2",
          type === "ai" ? "fit-content md:mr-10" : "md:ml-10"
        )}
      >
        <motion.p>{msg}</motion.p>
        {children && (
          <AnimatePresence>
            {done && (
              <motion.div
                animate={{
                  x: 0,
                  opacity: 1
                }}
                initial={{
                  x: -8,
                  opacity: 0
                }}
                exit={{
                  x: -8,
                  opacity: 0
                }}
                transition={{
                  type: "spring",
                  stiffness: 150,
                  damping: 19,
                  mass: 1.2
                }}
              >
                {children}
              </motion.div>
            )}
          </AnimatePresence>
        )}
      </div>
      <ChatArrow position={type === "ai" ? "left" : "right"} />
    </motion.div>
  );
}

export function TypedMessage({ message }: { message: string }) {
  const { next, type } = useChatMessageContext();
  const { visibleMessage, start } = useTypedMessage(message, {
    speed: type === "ai" ? 5 : 10,
    onDone: next
  });

  useEffect(() => {
    start();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- start once on mount
  }, []);

  return <p>{visibleMessage}</p>;
}
