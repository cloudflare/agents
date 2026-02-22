import { useState } from "react";
import { Logo } from "./logo";
import { useMotionValueEvent, useScroll, motion } from "framer-motion";
import clsx from "clsx";
import { Balancer } from "react-wrap-balancer";
import { AGENTS_DOCS_HREF, DASHBOARD_HREF } from "./links";

function Copy() {
  const [copied, setCopied] = useState(false);
  return (
    <motion.button
      transition={{
        type: "spring",
        stiffness: 280,
        damping: 18,
        mass: 0.3
      }}
      layout="position"
      className="hidden group md:flex gap-2 font-mono text-orange-600"
      onClick={() => {
        navigator.clipboard
          .writeText("npm i agents")
          .then(() => setCopied(true));
      }}
      onHoverEnd={() => setCopied(false)}
    >
      <svg
        className="group-hover:opacity-100 opacity-0"
        role="presentation"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 16 16"
        aria-hidden="true"
        focusable="false"
        width="16"
        fill="currentColor"
      >
        {copied ? (
          <path
            fillRule="evenodd"
            d="M14.485 4.347l-8.324 8.625-4.648-4.877.724-.69 3.929 4.123 7.6-7.875.72.694z"
          />
        ) : (
          <>
            <path d="M14 1.5H6l-.5.5v2.5h1v-2h7v7h-2v1H14l.5-.5V2l-.5-.5z" />
            <path d="M2 5.5l-.5.5v8l.5.5h8l.5-.5V6l-.5-.5H2zm7.5 8h-7v-7h7v7z" />
          </>
        )}
      </svg>
      <span>npm i agents</span>
    </motion.button>
  );
}

export function Header() {
  const [isSticking, setIsSticking] = useState(false);
  const [showLinks, setShowLinks] = useState(false);
  const { scrollY } = useScroll();

  useMotionValueEvent(scrollY, "change", (v: number) => {
    setIsSticking(v > 24);
    setShowLinks(v > 400);
  });

  return (
    <>
      <nav
        className={clsx(
          "text-orange-400 flex items-center p-6 sticky top-0 z-30 bg-white h-[73px]",
          isSticking ? "" : "border-b-0"
        )}
      >
        <Logo />
        <div className="flex ml-auto gap-8 items-center">
          <Copy />
          {showLinks && (
            <>
              <motion.a
                transition={{
                  type: "spring",
                  stiffness: 800,
                  damping: 80,
                  mass: 4
                }}
                animate={{ x: 0, opacity: 1 }}
                initial={{ x: 8, opacity: 0 }}
                className="hover:underline underline-offset-2 text-orange-600"
                href={AGENTS_DOCS_HREF}
                target="_blank"
              >
                View Docs ↗
              </motion.a>
              <motion.a
                transition={{
                  type: "spring",
                  stiffness: 800,
                  damping: 80,
                  mass: 4
                }}
                animate={{ x: 0, opacity: 1 }}
                initial={{ x: 8, opacity: 0 }}
                className="bg-orange-400 text-white h-8 px-3 flex items-center rounded-full ring ring-orange-400 ring-offset-2"
                href={DASHBOARD_HREF}
                target="_blank"
              >
                Get Started
              </motion.a>
            </>
          )}
        </div>
      </nav>
      <article className="relative bg-white px-6 flex flex-col justify-center text-center space-y-8 h-[520px] -mt-4 border-b border-orange-400">
        <h2 className="text-[clamp(56px,11vw,88px)] font-semibold leading-[0.9]">
          <Balancer>
            The Platform For <em>Building</em> Agents.
          </Balancer>
        </h2>
        <p className="max-w-[550px] mx-auto">
          Build agents on Cloudflare — the platform designed for durable
          execution, serverless inference, and pricing that scales up (and
          down).
        </p>
        <div className="flex items-center justify-center gap-4 font-semibold">
          <div className="bg-white p-1 border border-orange-400 rounded-full">
            <a
              className="bg-orange-400 text-white py-3 px-5 rounded-full hover:bg-orange-300 hover:text-inherit block"
              href={DASHBOARD_HREF}
              target="_blank"
            >
              Get Started
            </a>
          </div>
          <a
            className="py-3 px-5 rounded-full border-orange-400 border bg-white hover:bg-orange-100 block"
            href={AGENTS_DOCS_HREF}
            target="_blank"
          >
            View Docs
          </a>
        </div>
      </article>
    </>
  );
}
