import { useEffect, useRef, useState } from "react";
import { useTypedMessage } from "./chat";
import { useInView } from "framer-motion";

export function InstallCommand() {
  const ref = useRef<HTMLSpanElement>(null);
  const [playing, setPlaying] = useState(false);
  const { visibleMessage, start } = useTypedMessage("npm i agents", {
    speed: 100,
    onDone: () => setPlaying(false)
  });
  const inView = useInView(ref, { amount: 1, once: true });

  useEffect(() => {
    if (inView) start();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- start is stable, only trigger on visibility
  }, [inView]);

  return (
    <span ref={ref}>
      $ <span>{visibleMessage}</span>
      <span
        className={`h-[30px] lg:h-[40px] w-[15px] lg:w-[20px] bg-current inline-block lg:translate-y-[7px] translate-y-[6px] ${
          playing ? "" : "cursor"
        }`}
      />
    </span>
  );
}
