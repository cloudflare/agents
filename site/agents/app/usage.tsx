"use client";

import { motion, useInView } from "framer-motion";
import { useEffect, useId, useRef, useState } from "react";

const viewBoxSize = 60;

export function SavingsBackground({
  variant = "visible",
  startHidden = true
}: {
  variant?: "visible" | "hidden";
  startHidden?: boolean;
}) {
  const id = useId();
  return (
    <div className="absolute inset-0 text-orange-400">
      <svg width="100%" height="100%" aria-hidden="true">
        <defs>
          <pattern
            id={id}
            viewBox={`-${viewBoxSize / 2} -${
              viewBoxSize / 2
            } ${viewBoxSize} ${viewBoxSize}`}
            patternUnits="userSpaceOnUse"
            width="40"
            height="40"
          >
            <motion.text
              style={{ rotate: -45 }}
              animate={variant}
              variants={{
                visible: {
                  x: 0,
                  y: 0,
                  opacity: 1
                },
                hidden: { x: -48, y: 48, opacity: 0 }
              }}
              initial={startHidden ? "hidden" : undefined}
              className="font-sans"
              fill="currentColor"
              dominantBaseline="central"
              textAnchor="middle"
              transition={{
                type: "spring",
                stiffness: 26.7,
                damping: 4.1,
                mass: 0.2
              }}
            >
              savings
            </motion.text>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={`url(#${id})`} />
      </svg>
    </div>
  );
}

export function Usage() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inView = useInView(wrapperRef, { amount: 0.8, once: true });

  const [showBg, setShowBg] = useState(false);
  useEffect(() => {
    if (inView) {
      setTimeout(() => setShowBg(true), 1100);
    }
  }, [inView]);

  return (
    <div className="pt-24">
      <header className="p-6 pt-0">
        <p className="text-sm text-orange-600">
          <span className="tabular-nums">02</span> | Low Cost
        </p>
      </header>
      <div className="grid md:grid-cols-[1fr_2fr] py-6 border-t border-orange-400 border-dashed">
        <article className="mx-6 md:mx-0 md:px-6 pb-6 md:pb-0 border-b md:border-b-0 md:border-r border-orange-400">
          <h3 className="text-5xl font-semibold relative mb-6">
            Scale up.
            <br />
            <em>Or</em> down.
          </h3>
          <p className="mb-4">
            Inference is hard to predict and spiky in nature, unlike training.
            GPU utilization is, on average, only 20-40% — with one-third of
            organizations utilizing less than 15%.
          </p>
          <p>
            Workers AI allows customers to save by only paying for usage. No
            guessing or committing to hardware that goes unused.
          </p>
        </article>
        <div
          className="flex flex-col md:flex-row md:p-6 pt-6 md:py-0 md:gap-6 min-w-0"
          ref={wrapperRef}
        >
          <p className="text-sm text-end mr-6 md:hidden">
            What you pay for on a hyperscaler
          </p>
          <div className="flex justify-end overflow-hidden min-w-0 relative">
            <SavingsBackground variant={showBg ? "visible" : "hidden"} />
            <div className="absolute top-0 left-0 right-0 h-2 md:h-6 bg-white">
              <motion.div
                className="h-2 md:h-6 border-b border-current relative text-orange-400"
                animate={{ width: inView ? "100%" : "0%" }}
                initial={{ width: "0%" }}
                transition={{
                  type: "tween",
                  ease: "easeOut",
                  duration: 1
                }}
              >
                <svg
                  className="absolute right-0 top-0 md:top-4 -translate-y-px"
                  viewBox="0 0 8 16"
                  width="8"
                >
                  <path d="M0 0 l8 8 l-8 8" stroke="currentColor" fill="none" />
                </svg>
              </motion.div>
            </div>
            <svg
              className="border-b border-current text-orange-400 relative shrink-0"
              width="672"
              height="516"
              viewBox="0 0 672 516"
            >
              <motion.path
                transform="translate(0 20)"
                d="M 0,516 
                    C 42,516 59,430 85,301 
                    S 127,172 170,301 
                    S 212,516 254,430 
                    S 297,86 339,43 
                    S 381,86 424,301 
                    S 466,516 508,430 
                    S 551,258 593,301 
                    S 636,430 678,516 
                    L 678,516 Z"
                fill="white"
                stroke="currentColor"
                strokeDasharray="2731"
                strokeDashoffset="2731"
                animate={{ strokeDashoffset: inView ? 0 : 2731 }}
                transition={{
                  type: "tween",
                  ease: "easeOut",
                  duration: 1.5
                }}
              />
              {/* <g transform="translate(473 0)" stroke="currentColor">
                <path d="M0 24 V503" />
                <circle r="5" cy="24" fill="white" />
                <circle r="5" cy="503" fill="white" />
              </g> */}
              <g transform="translate(573 0)" stroke="currentColor">
                <motion.path
                  animate={{ pathLength: inView ? 1 : 0 }}
                  initial={{ pathLength: 0 }}
                  transition={{
                    delay: 0.8
                  }}
                  d="M0 310 V516"
                />
                <motion.circle
                  animate={{ scale: inView ? 1 : 0 }}
                  initial={{ scale: 0 }}
                  r="5"
                  cy="310"
                  fill="white"
                  transition={{
                    delay: 0.7
                  }}
                />
                <motion.circle
                  animate={{ scale: inView ? 1 : 0 }}
                  initial={{ scale: 0 }}
                  r="5"
                  cy="516"
                  fill="white"
                  transition={{
                    delay: 0.7
                  }}
                />
              </g>
            </svg>
          </div>
          <p className="text-sm text-center mr-11 mt-2 ml-auto md:hidden">
            What you pay for
            <br />
            on Cloudflare
          </p>
          <div className="w-[140px] hidden md:block relative leading-snug text-sm md:text-base">
            <motion.p
              animate={{ x: 0, opacity: 1 }}
              initial={{ x: -8, opacity: 0 }}
              transition={{
                type: "spring",
                stiffness: 150,
                damping: 19,
                mass: 1.2,
                delay: 1
              }}
            >
              What you pay for on a hyperscaler
            </motion.p>
            <div className="absolute bottom-[103px] translate-y-1/2">
              <motion.p
                animate={{ x: 0, opacity: 1 }}
                initial={{ x: -8, opacity: 0 }}
                transition={{
                  type: "spring",
                  stiffness: 150,
                  damping: 19,
                  mass: 1.2,
                  delay: 1
                }}
              >
                What you pay for on Cloudflare
              </motion.p>
              <motion.div
                animate={{ scale: inView ? 1 : 0 }}
                initial={{ scale: 0 }}
                style={{ originX: "left" }}
                transition={{
                  type: "spring",
                  stiffness: 150,
                  damping: 19,
                  mass: 1.2,
                  delay: 0.9
                }}
                className="absolute border-b border-orange-400 w-[115px] right-full mr-2 top-1/2"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
