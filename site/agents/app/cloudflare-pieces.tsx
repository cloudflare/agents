"use client";

import {
  createContext,
  Fragment,
  ReactNode,
  RefObject,
  useContext,
  useEffect,
  useRef,
  useState
} from "react";
import { motion } from "framer-motion";
import { BackgroundLines } from "./_components/background";
import { Logo } from "./logo";
import {
  ArrowCycle,
  Avatar,
  BrowserWindow,
  CallsLogo,
  Chat,
  Email,
  Gear,
  MultiCloud,
  PagesLogo,
  Phone,
  Sparkles,
  Storage,
  WorkersLogo
} from "./_components/icons";
import { withUtm } from "./links";

const ProductContext = createContext<{
  selectedProduct: string | null;
  setSelectedProduct: (product: string | null) => void;
} | null>(null);

const useProductContext = () => {
  const ctx = useContext(ProductContext);
  if (!ctx) throw new Error("useProductContext used outside of ProductContext");
  return ctx;
};

export function CloudflarePieces() {
  const [selectedProduct, setSelectedProduct] = useState<string | null>(null);
  return (
    <div className="pt-24">
      <header className="p-6 pt-0">
        <p className="text-sm text-orange-600">
          <span className="tabular-nums">01</span> | Comprehensive Product Suite
        </p>
      </header>
      <article className="p-6 space-y-6 lg:space-y-0 lg:flex items-end gap-6 relative overflow-hidden border-t border-orange-400 border-dashed">
        <div
          style={{
            width:
              "clamp(100px, calc(100px + (180 * ((100vw - 1024px) / 256))), 280px)"
          }}
          className="absolute right-6 -bottom-6 lg:bottom-0 text-orange-400 translate-x-[2px] lg:translate-x-2 translate-y-1.5"
        >
          <Logo size="100%" />
        </div>
        <h2 className="text-5xl font-semibold relative">
          Build agentic AI.
          <br className="hidden lg:block" /> Entirely on Cloudflare.
        </h2>
        <p className="max-w-[40ch] relative">
          Cloudflare’s extensive suite of products allows you to build AI agents
          entirely under one platform.
        </p>
      </article>
      <div className="border-b border-orange-400 mx-6" />
      <div className="grid md:grid-cols-[300px_1fr] lg:grid-cols-[1fr_2fr]">
        <ProductContext.Provider
          value={{ selectedProduct, setSelectedProduct }}
        >
          <article className="pb-6 md:pt-6">
            <div className="py-6 mx-6 h-[270px] overflow-hidden border-b border-orange-400 md:hidden">
              <UserInput width={300} />
              <svg
                viewBox="0 0 300 200"
                width="300"
                className="stroke-orange-400 mx-auto"
              >
                <line x1="32" y1="0" x2="32" y2="200" />
                <line x1="150" y1="0" x2="150" y2="200" />
                <line x1="268" y1="0" x2="268" y2="200" />
              </svg>
            </div>
            <AgentStep number={1} title="Get user input">
              <p>
                To start building an agent, we'll first need to get input from
                the user. Be it email, chat, or voice, Cloudflare can help you
                receive input in whichever form you prefer.
              </p>
              <ProductList
                products={{
                  Email: {
                    slug: "email-workers",
                    items: [
                      {
                        label: "Email Workers",
                        url: withUtm(
                          "https://developers.cloudflare.com/email-routing/email-workers/"
                        )
                      }
                    ]
                  },
                  Chat: {
                    slug: "chat",
                    items: [
                      {
                        label: "WebSockets",
                        url: withUtm(
                          "https://developers.cloudflare.com/workers/runtime-apis/websockets/"
                        )
                      },
                      {
                        label: "Pages",
                        url: withUtm("https://developers.cloudflare.com/pages/")
                      }
                    ]
                  },
                  Voice: {
                    slug: "voice",
                    items: [
                      {
                        label: "Calls",
                        url: withUtm("https://developers.cloudflare.com/calls/")
                      }
                    ]
                  }
                }}
              />
            </AgentStep>
            <div className="mx-6 border-b md:hidden border-orange-400">
              <div className="mx-auto w-fit">
                <AiLines width={300} height={150} />
              </div>
              <StepIcon>
                <Sparkles />
              </StepIcon>
              <svg className="mx-auto" viewBox="0 0 300 24" width="300">
                <path d="M 150 0 V 24" className="stroke-orange-400" />
              </svg>
            </div>
            <AgentStep number={2} title="Ask AI">
              <p>
                To plan and reason through the next course of action, or
                generate content, the agent will have to connect to an
                Large-Language Model (LLM). You can connect to an LLM running
                directly on Cloudflare or use AI Gateway to connect to popular
                providers.
              </p>
              <ProductList
                products={{
                  "Host an LLM": {
                    slug: "host-llm",
                    items: [
                      {
                        label: "Workers AI",
                        url: withUtm(
                          "https://developers.cloudflare.com/workers-ai/"
                        )
                      }
                    ]
                  },
                  "Connect to a provider": {
                    slug: "ai-provider",
                    items: [
                      {
                        label: "AI Gateway",
                        url: withUtm(
                          "https://developers.cloudflare.com/ai-gateway/"
                        )
                      }
                    ]
                  }
                }}
              />
            </AgentStep>
            <div className="mx-6 border-b md:hidden border-orange-400">
              <svg className="mx-auto" viewBox="0 0 300 24" width="300">
                <path d="M 150 0 V 24" className="stroke-orange-400" />
              </svg>
              <StepIcon>
                <Sparkles />
              </StepIcon>
              <svg
                className="mx-auto -my-8"
                viewBox="0 -65 300 130"
                width="300"
              >
                <circle
                  className="animate-spin stroke-orange-400"
                  style={{ transformOrigin: "150px 0px" }}
                  cx="150"
                  r="64"
                  strokeDasharray="3"
                  fill="none"
                />
              </svg>
              <div className="flex justify-between relative w-[300px] mx-auto">
                <svg
                  className="absolute left-0 right-0"
                  viewBox="0 0 300 64"
                  width="300"
                >
                  <path d="M 0 32 H 300" className="stroke-orange-400" />
                </svg>
                <StepIcon>
                  <ArrowCycle />
                </StepIcon>
                <StepIcon>
                  <Gear />
                </StepIcon>
                <StepIcon>
                  <Storage />
                </StepIcon>
              </div>
              <svg
                className="mx-auto -mt-[5px]"
                viewBox="0 -5 300 29"
                width="300"
              >
                <path d="M 140 -5 V 24" className="stroke-orange-400" />
                <path d="M 160 -5 V 24" className="stroke-orange-400" />
              </svg>
            </div>
            <AgentStep number={3} title="Guarantee execution">
              <p>
                Next, to make sure all the steps take action, the agent will
                need an execution engine that combines state and compute:
              </p>
              <ProductList
                products={{
                  State: {
                    slug: "state",
                    items: [
                      {
                        label: "Durable Objects",
                        url: withUtm(
                          "https://developers.cloudflare.com/durable-objects/"
                        )
                      }
                    ]
                  },
                  Compute: {
                    slug: "compute",
                    items: [
                      {
                        label: "Workflows",
                        url: withUtm(
                          "https://developers.cloudflare.com/workflows/"
                        )
                      }
                    ]
                  }
                }}
              />
              <p>
                Sometimes, you will need to go back to the LLM, and re-evaluate
                the plan based on new variables, and we support that too.
              </p>
            </AgentStep>
            <div className="mx-6 pb-6 border-b border-orange-400 md:hidden">
              <div className="w-fit mx-auto">
                <TakeActionLines width={300} height={150} />
              </div>
              <div className="flex justify-between w-[300px] mx-auto">
                <StepIcon>
                  <BrowserWindow />
                </StepIcon>
                <StepIcon>
                  <MultiCloud />
                </StepIcon>
              </div>
            </div>
            <AgentStep number={4} title="Take action">
              <p>
                Finally, the agent will need access to tools in order to
                complete the tasks. Tools provide a structured way for agents
                and workflows to invoke APIs, manipulate data, and integrate
                with external systems.
              </p>
              <ProductList
                products={{
                  APIs: {
                    slug: "api",
                    items: [
                      {
                        label: "MCP servers",
                        url: withUtm(
                          "https://developers.cloudflare.com/agents/model-context-protocol/"
                        )
                      }
                    ]
                  },
                  Utilities: {
                    slug: "utilities",
                    items: [
                      {
                        label: "Browser Rendering",
                        url: withUtm(
                          "https://developers.cloudflare.com/browser-rendering/"
                        )
                      },
                      {
                        label: "Vectorize",
                        url: withUtm(
                          "https://developers.cloudflare.com/vectorize/"
                        )
                      },
                      {
                        label: "D1",
                        url: withUtm("https://developers.cloudflare.com/d1/")
                      }
                    ]
                  }
                }}
              />
            </AgentStep>
          </article>
          <div className="hidden md:block lg:hidden relative">
            <Diagram width={400} />
          </div>
          <div className="hidden lg:block relative">
            <Diagram />
          </div>
        </ProductContext.Provider>
      </div>
    </div>
  );
}

type StickyState = "before-stick" | "sticking" | "after-stick";

export const useStickyState = (ref: RefObject<HTMLElement | null>) => {
  const [state, setState] = useState<StickyState>("before-stick");

  useEffect(() => {
    const handleScroll = () => {
      const el = ref.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      const stickyTop = parseInt(window.getComputedStyle(el).top);

      if (top < stickyTop) setState("after-stick");
      else if (top > stickyTop) setState("before-stick");
      else setState("sticking");
    };
    document.addEventListener("scroll", handleScroll);
    return () => document.removeEventListener("scroll", handleScroll);
  }, []);

  return state;
};

function ArrowDown({ x = 0, y = 0 }: { x?: number; y?: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <path
        d="M -8 -8 L 0 0 L 8 -8"
        className="stroke-orange-400"
        fill="none"
      />
    </g>
  );
}

function UserInput({ width = 500 }) {
  const { selectedProduct } = useProductContext();
  const opacity = selectedProduct === null ? 1 : 0.35;
  return (
    <div style={{ width }} className="flex flex-col items-center mx-auto">
      <StepIcon>
        <Avatar />
      </StepIcon>
      <motion.svg
        animate={{ opacity }}
        height="95"
        viewBox={`0 -5 ${width} 95`}
        style={{ marginTop: -5 }}
      >
        <g className="stroke-orange-400" fill="none">
          <path d={`M${width / 2} 0 V90`} />
          <path
            d={`M${width / 2 - 10} -5 C ${width / 2 - 10} 45 32 45 32 85 V 90`}
          />
          <path
            d={`M${width / 2 + 10} -5 C ${width / 2 + 10} 45 ${width - 32} 45 ${
              width - 32
            } 85 V 90`}
          />
        </g>
        <ArrowDown x={32} y={90} />
        <ArrowDown x={width / 2} y={90} />
        <ArrowDown x={width - 32} y={90} />
      </motion.svg>
      <div className="flex justify-between w-full">
        <StepIcon name="email-workers" left={[<WorkersLogo />]}>
          <Email />
        </StepIcon>
        <StepIcon name="chat" left={[<WorkersLogo />]} right={[<PagesLogo />]}>
          <Chat />
        </StepIcon>
        <StepIcon name="voice" right={[<CallsLogo />]}>
          <Phone />
        </StepIcon>
      </div>
    </div>
  );
}

function AiLines({ width = 500, height = 270 }) {
  const { selectedProduct } = useProductContext();
  const opacity = selectedProduct === null ? 1 : 0.35;

  const halfWidth = width / 2;
  const halfHeight = height / 2;

  const leftPath = `M32 -5 C 32 ${halfHeight} ${halfWidth - 10} ${halfHeight} ${
    halfWidth - 10
  } ${height}`;

  const rightPath = `M${width - 32} -5 C ${width - 32} ${halfHeight} ${
    halfWidth + 10
  } ${halfHeight} ${halfWidth + 10} ${height}`;

  return (
    <motion.svg
      height={height}
      viewBox={`0 -5 ${width} ${height}`}
      style={{ marginBottom: -10 }}
      animate={{ opacity }}
    >
      <g className="stroke-orange-400" fill="none">
        <path d={`M${halfWidth} -5 V${height - 25}`} />
        <path d={leftPath} />
        <path d={rightPath} />
      </g>
      <g
        style={{
          offsetPath: `path('${leftPath}')`,
          offsetDistance: "96%",
          offsetRotate: "auto -90deg"
        }}
      >
        <ArrowDown />
      </g>
      <ArrowDown x={width / 2} y={height - 25} />
      <g
        style={{
          offsetPath: `path('${rightPath}')`,
          offsetDistance: "96%",
          offsetRotate: "auto -90deg"
        }}
      >
        <ArrowDown />
      </g>
    </motion.svg>
  );
}

function TakeActionLines({ width = 500, height = 346 }) {
  const { selectedProduct } = useProductContext();
  const opacity = selectedProduct === null ? 1 : 0.35;

  const halfWidth = width / 2;
  const halfHeight = height / 2;

  const leftPath = `M${halfWidth - 10} -5 C ${
    halfWidth - 10
  } ${halfHeight} 32 ${halfHeight} 32 ${height}`;
  const rightPath = `M${halfWidth + 10} -5 C ${halfWidth + 10} ${halfHeight} ${
    width - 32
  } ${halfHeight} ${width - 32} ${height}`;

  return (
    <motion.svg
      height={height}
      viewBox={`0 -5 ${width} ${height}`}
      style={{ marginBottom: -10 }}
      animate={{ opacity }}
    >
      <g className="stroke-orange-400" fill="none">
        <path d={leftPath} />
        <path d={rightPath} />
      </g>
      <g
        style={{
          offsetPath: `path('${leftPath}')`,
          offsetDistance: "96.5%",
          offsetRotate: "auto -90deg"
        }}
      >
        <ArrowDown />
      </g>
      <g
        style={{
          offsetPath: `path('${rightPath}')`,
          offsetDistance: "96.5%",
          offsetRotate: "auto -90deg"
        }}
      >
        <ArrowDown />
      </g>
    </motion.svg>
  );
}

function Diagram({ width = 500 }) {
  const { selectedProduct } = useProductContext();
  const opacity = selectedProduct === null ? 1 : 0.35;

  const stickyRef = useRef<HTMLDivElement>(null);
  const stickyState = useStickyState(stickyRef);

  return (
    <figure>
      <BackgroundLines />
      <div className="relative h-full mx-auto" style={{ width }}>
        <div className="mt-[90px]">
          <UserInput width={width} />
        </div>
        <div className="relative">
          <div ref={stickyRef} className="sticky top-12 mb-24 z-20">
            <AiLines width={width} />
            <StepIcon
              name={{ left: "host-llm", right: "ai-provider" }}
              left={[<WorkersLogo />]}
              right={[
                <svg
                  width="28"
                  viewBox="0 0 24 24"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M20.5677 10.1865C21.0215 8.82449 20.8652 7.33247 20.1395 6.09361C19.0482 4.19343 16.8542 3.21583 14.7115 3.67588C13.7583 2.60202 12.3888 1.99134 10.953 2.00009C8.76283 1.99509 6.81952 3.40523 6.1457 5.48917C4.7387 5.77732 3.52421 6.65803 2.81351 7.90628C1.71404 9.80146 1.96468 12.1904 3.43357 13.8156C2.97978 15.1776 3.13604 16.6696 3.86174 17.9085C4.95309 19.8087 7.14705 20.7862 9.28975 20.3262C10.2423 21.4001 11.6125 22.0107 13.0482 22.0014C15.2397 22.007 17.1836 20.5956 17.8574 18.5098C19.2644 18.2216 20.4789 17.3409 21.1896 16.0927C22.2879 14.1975 22.0366 11.8104 20.5683 10.1852L20.5677 10.1865ZM13.0495 20.6944C12.1725 20.6956 11.3231 20.3887 10.6499 19.8268C10.6805 19.8105 10.7336 19.7811 10.768 19.7599L14.7509 17.4597C14.9547 17.344 15.0797 17.1271 15.0784 16.8927V11.2778L16.7617 12.2498C16.7798 12.2586 16.7917 12.2761 16.7942 12.2961V16.9459C16.7917 19.0136 15.1172 20.69 13.0495 20.6944ZM4.99622 17.2547C4.5568 16.4958 4.39866 15.6064 4.5493 14.7432C4.57868 14.7607 4.63056 14.7926 4.66744 14.8138L8.65032 17.114C8.85221 17.2322 9.10223 17.2322 9.30475 17.114L14.1671 14.3063V16.2502C14.1683 16.2702 14.159 16.2896 14.1433 16.3021L10.1173 18.6267C8.32404 19.6593 6.03382 19.0455 4.99685 17.2547H4.99622ZM3.948 8.56071C4.38554 7.80064 5.07623 7.21934 5.89881 6.91743C5.89881 6.95181 5.89693 7.01244 5.89693 7.05495V11.656C5.89568 11.8898 6.02069 12.1067 6.22384 12.2223L11.0862 15.0294L9.40289 16.0014C9.38601 16.0127 9.36476 16.0145 9.34601 16.0064L5.31938 13.6799C3.52983 12.6436 2.91602 10.354 3.94737 8.56134L3.948 8.56071ZM17.7781 11.7791L12.9157 8.97138L14.599 8.00003C14.6159 7.98878 14.6371 7.98691 14.6559 7.99504L18.6825 10.3196C20.4752 11.3554 21.0896 13.6487 20.0539 15.4414C19.6157 16.2002 18.9257 16.7815 18.1037 17.084V12.3454C18.1056 12.1117 17.9812 11.8954 17.7787 11.7791H17.7781ZM19.4532 9.25765C19.4238 9.23953 19.372 9.20827 19.3351 9.18702L15.3522 6.88681C15.1503 6.76867 14.9003 6.76867 14.6978 6.88681L9.83543 9.69457V7.75064C9.83418 7.73063 9.84355 7.71126 9.85918 7.69876L13.8852 5.37604C15.6785 4.34156 17.9712 4.95725 19.005 6.75117C19.442 7.50874 19.6001 8.3957 19.452 9.25765H19.4532ZM8.92034 12.7224L7.23643 11.7504C7.21831 11.7416 7.20643 11.7241 7.20393 11.7041V7.05432C7.20518 4.98413 8.88471 3.30647 10.9549 3.30772C11.8306 3.30772 12.6782 3.61525 13.3514 4.1753C13.3208 4.19155 13.2683 4.22093 13.2333 4.24218L9.25037 6.5424C9.0466 6.65803 8.92159 6.8743 8.92284 7.1087L8.92034 12.7211V12.7224ZM9.8348 10.7509L12.0006 9.50018L14.1665 10.7503V13.2512L12.0006 14.5013L9.8348 13.2512V10.7509Z"
                    fill="currentColor"
                  />
                </svg>,
                <svg
                  width="28"
                  viewBox="0 0 24 24"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M17.0977 4H13.5611L19.8941 20H23.3484L17.0977 4ZM6.89916 4L0.648438 20H4.18503L5.58322 16.6359H12.1629L13.4789 19.9179H17.0155L10.6003 4H6.98141H6.89916ZM6.57018 13.6821L8.70858 8.02051L10.9292 13.6821H6.65242H6.57018Z"
                    fill="currentColor"
                  />
                </svg>
              ]}
            >
              <Sparkles />
            </StepIcon>
          </div>
          <motion.svg
            height="400"
            viewBox={`0 0 ${width} 400`}
            style={{ marginBottom: -32, marginTop: -128 }}
            animate={{ opacity }}
          >
            <g className="stroke-orange-400" fill="none">
              <motion.path
                animate={{
                  opacity: stickyState === "after-stick" ? 0 : 1
                }}
                d={`M${width / 2} 0 V400`}
              />
              <motion.circle
                animate={{
                  scale: stickyState === "after-stick" ? 1 : 0,
                  opacity: stickyState === "after-stick" ? 1 : 0
                }}
                initial={{ scale: 0, opacity: 0 }}
                transition={{
                  type: "spring",
                  stiffness: 150,
                  damping: 19,
                  mass: 1.2
                }}
                className="animate-spin"
                style={{ transformOrigin: `${width / 2}px 336px` }}
                cx={width / 2}
                cy="336"
                r="64"
                strokeDasharray="3"
              />
              <path d={`M0 399 H${width}`} />
            </g>
          </motion.svg>
        </div>
        <div className="flex justify-between w-full">
          <StepIcon name="compute" left={[<WorkersLogo />]}>
            <ArrowCycle />
          </StepIcon>
          <StepIcon>
            <Gear />
          </StepIcon>
          <StepIcon
            name="state"
            right={[
              <svg viewBox="0 0 64 64" width="28">
                <path
                  fill="currentColor"
                  fillRule="evenodd"
                  d="M32.214 6h-.202a26 26 0 1 0 .327 52q.266 0 .527-.014A26 26 0 0 0 58.012 32 26 26 0 0 0 32.865 6.014a10 10 0 0 0-.65-.013m-9.503 6.063A22 22 0 0 0 10.104 30h7.804q.068-1.79.252-3.51l3.998.24A46 46 0 0 0 21.91 30H30V10.519c-1.784.81-3.475 2.582-4.9 5.41q-.139.278-.274.567l-3.873-1.145q.276-.627.575-1.221c.363-.72.757-1.412 1.182-2.067M30 34h-8.09c.226 5.584 1.392 10.5 3.19 14.071 1.425 2.829 3.116 4.6 4.9 5.41zm-7.29 17.937a22 22 0 0 1-1.182-2.067c-2.131-4.233-3.393-9.795-3.62-15.87h-7.806A22 22 0 0 0 22.71 51.937m19.554-.472A22 22 0 0 0 53.921 34h-7.15a51 51 0 0 1-.26 3.589l-3.998-.24q.185-1.627.255-3.349H34v19.742c2.032-.641 3.973-2.486 5.577-5.671q.129-.255.252-.517l3.874 1.145q-.267.6-.553 1.171a23 23 0 0 1-.885 1.595M42.768 30H34V10.258c2.032.641 3.973 2.486 5.577 5.671 1.799 3.572 2.965 8.487 3.191 14.071m4.003 0c-.227-6.075-1.49-11.637-3.621-15.87a22 22 0 0 0-.885-1.595A22 22 0 0 1 53.921 30z"
                  clipRule="evenodd"
                />
              </svg>
            ]}
          >
            <Storage />
          </StepIcon>
        </div>
        <div className="-mt-2.5">
          <TakeActionLines width={width} />
        </div>
        <div className="flex justify-between w-full">
          <StepIcon
            name="api"
            left={[
              <svg viewBox="0 0 80 80" width="28">
                <path
                  transform="translate(-7 -7)"
                  fill="currentColor"
                  d="M69.3 39.7c-3.1 0-5.8 2.1-6.7 5H48.3V34h4.6l4.5-2.5c1.1.8 2.5 1.2 3.9 1.2 3.8 0 7-3.1 7-7s-3.1-7-7-7-7 3.1-7 7c0 .9.2 1.8.5 2.6L51.9 30h-3.5V18.8h-.1c-1.3-1-2.9-1.6-4.5-1.9h-.2c-1.9-.3-3.9-.1-5.8.6-.4.1-.8.3-1.2.5h-.1c-.1.1-.2.1-.3.2-1.7 1-3 2.4-4 4 0 .1-.1.2-.1.2l-.3.6c0 .1-.1.1-.1.2v.1h-.6c-2.9 0-5.7 1.2-7.7 3.2-2.1 2-3.2 4.8-3.2 7.7 0 .7.1 1.4.2 2.1-1.3.9-2.4 2.1-3.2 3.5s-1.2 2.9-1.4 4.5c-.1 1.6.1 3.2.7 4.7s1.5 2.9 2.6 4c-.8 1.8-1.2 3.7-1.1 5.6 0 1.9.5 3.8 1.4 5.6s2.1 3.2 3.6 4.4c1.3 1 2.7 1.7 4.3 2.2v-.1q2.25.75 4.8.6h.1c0 .1.1.1.1.1.9 1.7 2.3 3 4 4 .1.1.2.1.3.2h.1c.4.2.8.4 1.2.5 1.4.6 3 .8 4.5.7.4 0 .8-.1 1.3-.1h.1c1.6-.3 3.1-.9 4.5-1.9V62.9h3.5l3.1 1.7c-.3.8-.5 1.7-.5 2.6 0 3.8 3.1 7 7 7s7-3.1 7-7-3.1-7-7-7c-1.5 0-2.8.5-3.9 1.2l-4.6-2.5h-4.6V48.7h14.3c.9 2.9 3.5 5 6.7 5 3.8 0 7-3.1 7-7s-3.1-7-7-7m-7.9-16.9c1.6 0 3 1.3 3 3s-1.3 3-3 3-3-1.3-3-3 1.4-3 3-3m0 41.4c1.6 0 3 1.3 3 3s-1.3 3-3 3-3-1.3-3-3 1.4-3 3-3M44.3 72c-.4.2-.7.3-1.1.3-.2 0-.4.1-.5.1h-.2c-.9.1-1.7 0-2.6-.3-1-.3-1.9-.9-2.7-1.7-.7-.8-1.3-1.7-1.6-2.7l-.3-1.5v-.7q0-.75.3-1.5c.1-.2.1-.4.2-.7s.3-.6.5-.9c0-.1.1-.1.1-.2.1-.1.1-.2.2-.3s.1-.2.2-.3c0 0 0-.1.1-.1l.6-.6-2.7-3.5c-1.3 1.1-2.3 2.4-2.9 3.9-.2.4-.4.9-.5 1.3v.1c-.1.2-.1.4-.1.6-.3 1.1-.4 2.3-.3 3.4-.3 0-.7 0-1-.1-2.2-.4-4.2-1.5-5.5-3.2-1.4-1.7-2-3.9-1.8-6.1q.15-1.2.6-2.4l.3-.6c.1-.2.2-.4.3-.5 0 0 0-.1.1-.1.4-.7.9-1.3 1.5-1.9 1.6-1.5 3.8-2.3 6-2.3q1.05 0 2.1.3v-4.5c-.7-.1-1.4-.2-2.1-.2-1.8 0-3.5.4-5.2 1.1-.7.3-1.3.6-1.9 1s-1.1.8-1.7 1.3c-.3.2-.5.5-.8.8-.6-.8-1-1.6-1.3-2.6-.2-1-.2-2 0-2.9.2-1 .6-1.9 1.3-2.6.6-.8 1.4-1.4 2.3-1.8l1.8-.9-.7-1.9c-.4-1-.5-2.1-.4-3.1s.5-2.1 1.1-2.9q.9-1.35 2.4-2.1c.9-.5 2-.8 3-.7.5 0 1 .1 1.5.2 1 .2 1.8.7 2.6 1.3s1.4 1.4 1.8 2.3l4.1-1.5c-.9-2-2.3-3.7-4.2-4.9q-.6-.3-.9-.6c.4-.7 1-1.4 1.6-1.9.8-.7 1.8-1.1 2.9-1.3.9-.2 1.7-.1 2.6 0 .4.1.7.2 1.1.3V72zm25-22.3c-1.6 0-3-1.3-3-3 0-1.6 1.3-3 3-3s3 1.3 3 3c0 1.6-1.3 3-3 3"
                ></path>
              </svg>
            ]}
          >
            <MultiCloud />
          </StepIcon>
          <StepIcon
            name="utilities"
            left={[
              <svg viewBox="0 0 48 48" width="28">
                <path
                  fill="currentColor"
                  fillRule="evenodd"
                  d="M7.388 36.971V5.77h3v5.282h2.957l1.5-1.5h1.5l1.5 1.5h2.795l1.5-1.5h1.5l1.5 1.5h12.323V5.77h3v31.201h1.512v2.873h1.52v3H4.505v-3H5.88V36.97zm5.958-22.914 1.5 1.5h1.499l1.499-1.5h2.796l1.5 1.5h1.5l1.498-1.5h12.325v6.066h-3.85l-1.499-1.5h-1.5l-1.5 1.5h-11.27l-1.5-1.5h-1.499l-1.5 1.5h-2.958v-6.066zm0 9.072h-2.959v5.931h11.377l1.499-1.5h1.5l1.499 1.5h2.853l1.5-1.5h1.5l1.499 1.5h3.85v-5.93h-3.85l-1.5 1.5h-1.5l-1.5-1.5h-11.27l-1.5 1.5h-1.499zm8.417 8.936 1.5 1.5h1.5l1.5-1.5h2.852l1.5 1.5h1.5l1.499-1.5h3.85v4.906H10.387v-4.906z"
                  clipRule="evenodd"
                />
              </svg>
            ]}
            right={[
              <svg viewBox="0 0 65 65" width="28">
                <path
                  fill="currentColor"
                  d="M23.3 18.2a2.1 2.1 0 1 1-4.2 0 2.1 2.1 0 0 1 4.2 0m-6.7 0a2.1 2.1 0 1 1-4.2 0 2.1 2.1 0 0 1 4.2 0m13.3-.61a2.1 2.1 0 1 0 0 1.22zm28.1-1.6V12.7l-2-2h-1.39v5.29zm0 9.67v-4.99h-3.39v4.99zm0 9.67v-4.99h-3.39v4.99zM58 45v-4.99h-3.39V45zm-3.39 9.6H56l2-2v-2.93h-3.39zm-17.9-4H41v4h-4.29zm8.96 0h4.29v4h-4.29zm-8.96-29H41v4h-4.29zm8.96 0h4.29v4h-4.29zm4.29-6.9h-4.29v-4h4.29zm-8.96 0h-4.29v-4H41zm-8.96-4h-24l-2 2v39.9l2 2h24v-4h-22v-25h22v-4h-22v-6.9h22z"
                />
              </svg>
            ]}
          >
            <BrowserWindow />
          </StepIcon>
        </div>
      </div>
    </figure>
  );
}

function StepIcon({
  name,
  left,
  right,
  children
}: {
  name?: string | { left: string; right: string };
  left?: ReactNode[];
  right?: ReactNode[];
  children: ReactNode;
}) {
  const { selectedProduct } = useProductContext();

  const getOpacity = () => {
    if (selectedProduct === null) return 1;
    if (!name) return 0.35;
    if (typeof name === "string") {
      return selectedProduct === name ? 1 : 0.35;
    }
    return name.left === selectedProduct || name.right === selectedProduct
      ? 1
      : 0.35;
  };

  return (
    <div className="relative flex items-center justify-center">
      {left?.map((p, i) => {
        const isActive =
          typeof name === "string"
            ? selectedProduct === name
            : name?.left === selectedProduct;
        return (
          <motion.div
            key={i}
            className="absolute w-10 h-10 ring ring-orange-400 ring-offset-2 rounded-full bg-orange-400 flex items-center justify-center text-white"
            animate={{ x: isActive ? -1 * i * 36 - 48 : 0 }}
            transition={{
              type: "spring",
              stiffness: 800,
              damping: 80,
              mass: 4
            }}
          >
            {p}
          </motion.div>
        );
      })}
      {right?.map((p, i) => {
        const isActive =
          typeof name === "string"
            ? selectedProduct === name
            : name?.right === selectedProduct;
        return (
          <motion.div
            key={i}
            className="absolute w-10 h-10 ring ring-orange-400 ring-offset-2 rounded-full bg-orange-400 flex items-center justify-center text-white"
            animate={{ x: isActive ? i * 36 + 48 : 0 }}
            transition={{
              type: "spring",
              stiffness: 800,
              damping: 80,
              mass: 4
            }}
          >
            {p}
          </motion.div>
        );
      })}
      <div className="bg-white rounded-full w-16 h-16 relative z-20">
        <motion.div
          className="text-orange-400 border border-orange-400 rounded-full flex items-center justify-center h-full"
          animate={{
            opacity: getOpacity()
          }}
        >
          {children}
        </motion.div>
      </div>
    </div>
  );
}

function AgentStep({
  number,
  title,
  children
}: {
  number: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      className="space-y-4 border-orange-400 border-b last:pb-0 last:border-b-0 md:border-b-0 md:mx-0 md:px-6 mx-6 md:border-r md:h-[400px] pb-6 pt-6 md:pt-0 md:pb-0"
      style={{ flex: 1 }}
    >
      <h3 className="text-xl font-semibold">
        {number}. {title}
      </h3>
      {children}
    </section>
  );
}

function ProductList({
  products
}: {
  products: Record<
    string,
    {
      slug: string;
      items: { label: string; url: string }[];
    }
  >;
}) {
  const { setSelectedProduct } = useProductContext();
  return (
    <ul className="divide-y divide-orange-400">
      {Object.entries(products).map(([label, products]) => {
        return (
          <motion.li
            className="py-2 relative group"
            onHoverStart={() => setSelectedProduct(products.slug)}
            onHoverEnd={() => setSelectedProduct(null)}
            key={label}
          >
            <div className="absolute -left-6 -right-6 top-0 bottom-0 bg-orange-100 opacity-0 group-hover:opacity-100" />
            <div className="relative flex justify-between gap-2">
              <p>{label}</p>
              <p className="flex flex-col items-end lg:flex-row lg:flex-wrap lg:items-baseline lg:justify-end">
                {products.items.map((p, i) => {
                  return (
                    <Fragment key={p.label}>
                      <a
                        className="hover:underline underline-offset-3"
                        href={p.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {p.label} ↗
                      </a>
                      {i < products.items.length - 1 ? (
                        <span className="hidden lg:inline">, </span>
                      ) : null}
                    </Fragment>
                  );
                })}
              </p>
            </div>
          </motion.li>
        );
      })}
    </ul>
  );
}
