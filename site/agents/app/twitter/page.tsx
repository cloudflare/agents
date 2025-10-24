"use client";

import { useState } from "react";
import { BackgroundDots } from "../_components/background";
import { useTypedMessage } from "../_components/chat";

export default function TwitterPage() {
  const [playing, setPlaying] = useState(false);
  const { visibleMessage, start } = useTypedMessage("npm i agents", {
    speed: 100,
    onDone: () => setPlaying(false)
  });
  return (
    <div className="h-screen w-screen flex items-center justify-center relative">
      <div className="text-orange-400 absolute inset-0">
        <BackgroundDots />
      </div>
      <div className="border border-orange-400 p-8 pt-[25px] rounded-lg bg-white relative">
        <div className="font-mono text-4xl text-orange-700">
          $ <span>{visibleMessage}</span>
          <span
            className={`h-[40px] w-[20px] bg-current inline-block translate-y-[7px] ${
              playing ? "" : "cursor"
            }`}
          />
        </div>
      </div>
      <button
        className="fixed bottom-8"
        onClick={() => {
          start();
          setPlaying(true);
        }}
      >
        start
      </button>
    </div>
  );
}
