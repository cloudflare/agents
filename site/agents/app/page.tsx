import { HeaderVisual } from "./header-visual";
import { Logo } from "./logo";
import { BackgroundDots } from "./_components/background";
import { AgentsIntro } from "./agents-intro";
import { CloudflarePieces } from "./cloudflare-pieces";
import { CloudflareCost } from "./cloudflare-cost";
import { Usage } from "./usage";
import { Header } from "./header";
import { DevInstructions } from "./dev-instructions";
import { FooterVisual } from "./_components/footer-visual";
import { DASHBOARD_HREF } from "./links";

function Quote() {
  return (
    <div className="p-6 pt-20 md:pt-6 space-y-4">
      <p className="md:text-xl md:text-center md:max-w-[600px] mx-auto">
        “At Knock we’re using the Cloudflare Agents SDK to build and ship our
        remote MCP server, helping deliver an exceptional developer experience
        to our customers in no time at all.ˮ
      </p>
      <p className="md:text-center">— Chris Bell, CTO, Knock</p>
    </div>
  );
}

function HomeBackground() {
  return (
    <>
      <div className="fixed inset-0 text-orange-100 pointer-events-none">
        <BackgroundDots />
      </div>
      <div className="absolute top-0 bottom-0 border-r border-orange-400 border-dashed" />
      <div className="absolute top-0 bottom-0 right-2 lg:right-6 border-l border-orange-400 border-dashed" />
      <div className="absolute left-0 right-0 border-b border-orange-400 border-dashed" />
      <div className="absolute left-0 right-0 bottom-2 lg:bottom-6 border-b border-orange-400 border-dashed" />
    </>
  );
}

const AGENTS_EMAIL = "1800-agents@cloudflare.com";

function Footer() {
  return (
    <>
      <footer className="overflow-hidden">
        <div className="p-6 lg:flex justify-between items-center relative z-20">
          <h3 className="text-5xl lg:text-7xl font-semibold">
            Get started on
            <br />
            Cloudflare today.
          </h3>
          <div className="text-xl font-semibold flex gap-3 justify-between md:justify-start md:mr-6 mt-12 lg:mt-0">
            <div className="bg-white p-1 border border-orange-400 rounded-full">
              <a
                className="bg-orange-400 text-white py-3 px-5 block rounded-full"
                target="_blank"
                href={DASHBOARD_HREF}
              >
                Get Started
              </a>
            </div>
            <a
              className="py-3 px-5 rounded-full border-orange-400 border bg-white flex items-center"
              href={`mailto:${AGENTS_EMAIL}`}
              target="_blank"
            >
              Contact Us
            </a>
          </div>
        </div>
        <div className="relative h-[80px] lg:h-[130px]">
          <div
            className="absolute left-0 text-orange-400"
            style={{
              transform: "translate(-500px, 0px)"
            }}
          >
            <Logo size={900} />
          </div>
          <div
            className="absolute left-0 text-orange-400 hidden lg:block"
            style={{
              transform: "translate(-50px, 0px)"
            }}
          >
            <Logo size={900} />
          </div>
          <div
            className="absolute -right-8 bottom-0 text-orange-400 md:w-[400px] lg:w-[900px]"
            style={{
              transform: "translate(0px, 20px)"
            }}
          >
            <Logo size="100%" />
          </div>
        </div>
      </footer>
    </>
  );
}

export default function Home() {
  return (
    <>
      <div className="p-2 lg:p-6 min-h-screen flex flex-col relative max-w-[1400px] mx-auto">
        <HomeBackground />
        <main className="grow border border-orange-400 text-orange-700 divide-y divide-orange-400 bg-white relative">
          <Header />
          <HeaderVisual />
          <AgentsIntro />
          <CloudflarePieces />
          <Usage />
          <CloudflareCost />
          <Quote />
          <DevInstructions />
          <Footer />
        </main>
        <p className="text-sm font-mono text-orange-500 w-max absolute -bottom-6 md:-bottom-5 lg:-bottom-1 left-1/2 -translate-x-1/2">
          Cloudflare{" "}
          <a
            href="https://www.cloudflare.com/website-terms/"
            target="_blank"
            className="underline underline-offset-2 decoration-dashed"
          >
            Terms of Use
          </a>
        </p>
      </div>
      <FooterVisual />
    </>
  );
}
