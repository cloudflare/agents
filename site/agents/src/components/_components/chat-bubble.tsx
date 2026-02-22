import clsx from "clsx";
import type { CSSProperties, ReactNode } from "react";

export function ChatBubble({
  children,
  arrowPosition = "left",
  style
}: {
  children: ReactNode;
  arrowPosition?: "left" | "right";
  style?: CSSProperties;
}) {
  return (
    <div className="relative" style={style}>
      <div className="bg-white w-fit p-4 rounded-xl border border-orange-400 min-h-[58px]">
        {children}
      </div>
      <ChatArrow position={arrowPosition} />
    </div>
  );
}

export function ChatArrow({
  position = "left"
}: {
  position?: "left" | "right";
}) {
  return (
    <svg
      viewBox="-1 -1 34 34"
      width="24"
      className={clsx(
        "text-orange-400 absolute bottom-4",
        position === "right"
          ? "-scale-x-100 left-[calc(100%-2px)]"
          : "right-[calc(100%-2px)]"
      )}
    >
      <path
        d="M0 32 H32 V0 Z"
        fill="white"
        stroke="currentColor"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d="M 32 -0.5 V 32.5"
        stroke="white"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
