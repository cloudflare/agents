import { callable, routeAgentRequest } from "agents";
import { createWorkersAI } from "workers-ai-provider";
import { Think } from "@cloudflare/think";
import { createGeneratedApp } from "@cloudflare/worker-bundler";
import type {
  AssetConfig,
  GeneratedApp,
  GeneratedAppBuildState
} from "@cloudflare/worker-bundler";
import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import type { FileInfo } from "@cloudflare/shell";
import { createWorkspaceSourceProvider } from "@cloudflare/shell";

type Env = {
  AI: Ai;
  LOADER: WorkerLoader;
  SlideDeckAgent: DurableObjectNamespace<SlideDeckAgent>;
};

export interface SlideDeckState {
  built: boolean;
  previewVersion: number;
  slideCount: number;
  slideFiles: string[];
  warnings?: string[];
  error?: string;
  updatedAt?: number;
  sourceFiles?: Record<string, string>;
}

const INITIAL_STATE: SlideDeckState = {
  built: false,
  previewVersion: 0,
  slideCount: 0,
  slideFiles: []
};

const GENERATED_APP_PACKAGE_JSON = JSON.stringify(
  {
    private: true,
    type: "module",
    dependencies: {
      react: "^19.2.6",
      "react-dom": "^19.2.6"
    },
    devDependencies: {}
  },
  null,
  2
);

const GENERATED_APP_SERVER = [
  "export default {",
  "  fetch() {",
  "    return new Response('Not found', { status: 404 });",
  "  }",
  "};",
  ""
].join("\n");

const GENERATED_APP_CLIENT = [
  "import { useEffect, useState } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { slides } from './registry';",
  "",
  "const SLIDE_WIDTH = 1200;",
  "const SLIDE_HEIGHT = 675;",
  "const PREVIEW_PADDING_X = 48;",
  "const PREVIEW_PADDING_Y = 112;",
  "",
  "function getSlideIndex() {",
  "  const hash = window.location.hash.slice(1);",
  "  const index = slides.findIndex((slide) => slide.name === hash);",
  "  return index >= 0 ? index : 0;",
  "}",
  "",
  "function getScale() {",
  "  const widthScale = (window.innerWidth - PREVIEW_PADDING_X) / SLIDE_WIDTH;",
  "  const heightScale = (window.innerHeight - PREVIEW_PADDING_Y) / SLIDE_HEIGHT;",
  "  return Math.max(0.1, Math.min(widthScale, heightScale, 1));",
  "}",
  "",
  "function App() {",
  "  const [index, setIndex] = useState(getSlideIndex);",
  "  const [scale, setScale] = useState(getScale);",
  "  useEffect(() => {",
  "    const onHashChange = () => setIndex(getSlideIndex());",
  "    window.addEventListener('hashchange', onHashChange);",
  "    return () => window.removeEventListener('hashchange', onHashChange);",
  "  }, []);",
  "  useEffect(() => {",
  "    const onResize = () => setScale(getScale());",
  "    window.addEventListener('resize', onResize);",
  "    return () => window.removeEventListener('resize', onResize);",
  "  }, []);",
  "  const slide = slides[index];",
  "  const Slide = slide?.Component;",
  "",
  "  return (",
  '    <main className="deck-shell">',
  "      <div",
  '        className="slide-viewport"',
  "        style={{ width: SLIDE_WIDTH * scale, height: SLIDE_HEIGHT * scale }}",
  "      >",
  '        <div className="slide-stage" style={{ transform: `scale(${scale})` }}>',
  "          {Slide ? <Slide /> : <p>No slides yet.</p>}",
  "        </div>",
  "      </div>",
  "      {slides.length > 1 && (",
  '        <nav className="deck-nav" aria-label="Slides">',
  "          {slides.map((entry, i) => (",
  "            <a key={entry.name} href={`#${entry.name}`} className={i === index ? 'active' : ''}>",
  "              {i + 1}",
  "            </a>",
  "          ))}",
  "        </nav>",
  "      )}",
  "    </main>",
  "  );",
  "}",
  "",
  "const root = document.getElementById('root');",
  "if (!root) throw new Error('Root element not found');",
  "createRoot(root).render(<App />);",
  ""
].join("\n");

const DEFAULT_COMPONENTS = [
  "import type { ReactNode } from 'react';",
  "",
  "export const SLIDE_WIDTH = 1200;",
  "export const SLIDE_HEIGHT = 675;",
  "",
  "interface WithChildren {",
  "  children: ReactNode;",
  "  className?: string;",
  "}",
  "",
  "export function SlideFrame({ children, className = '' }: WithChildren) {",
  "  return (",
  "    <section className={`slide-frame ${className}`}>",
  '      <div className="slide-frame-inner" />',
  '      <div className="slide-content">{children}</div>',
  "    </section>",
  "  );",
  "}",
  "",
  "export function SlideHeader({ eyebrow, title }: { eyebrow?: string; title?: string }) {",
  "  return (",
  '    <header className="slide-header">',
  '      <div className="slide-header-left">',
  '        {eyebrow && <span className="eyebrow">{eyebrow}</span>}',
  '        {title && <span className="product-name">{title}</span>}',
  "      </div>",
  '      <div className="cloudflare-mark">Cloudflare</div>',
  "    </header>",
  "  );",
  "}",
  "",
  "export function Eyebrow({ children, className = '' }: WithChildren) {",
  "  return <p className={`eyebrow ${className}`}>{children}</p>;",
  "}",
  "",
  "export function BigTitle({ children, className = '' }: WithChildren) {",
  "  return <h1 className={`big-title ${className}`}>{children}</h1>;",
  "}",
  "",
  "export function Lead({ children, className = '' }: WithChildren) {",
  "  return <p className={`lead ${className}`}>{children}</p>;",
  "}",
  "",
  "export function Pill({ children, className = '' }: WithChildren) {",
  "  return <span className={`pill ${className}`}>{children}</span>;",
  "}",
  "",
  "export function Card({ children, className = '' }: WithChildren) {",
  "  return <div className={`card ${className}`}>{children}</div>;",
  "}",
  "",
  "export function FeatureCard({ title, description }: { title: string; description: string }) {",
  "  return (",
  '    <Card className="feature-card">',
  '      <h3 className="card-title">{title}</h3>',
  '      <p className="card-copy">{description}</p>',
  "    </Card>",
  "  );",
  "}",
  "",
  "export function Stat({ value, label }: { value: string; label: string }) {",
  "  return (",
  '    <div className="stat">',
  "      <strong>{value}</strong>",
  "      <span>{label}</span>",
  "    </div>",
  "  );",
  "}",
  "",
  "export function CodeBlock({ children, filename }: { children: ReactNode; filename?: string }) {",
  "  return (",
  '    <pre className="code-block">',
  '      {filename && <span className="code-filename">{filename}</span>}',
  "      <code>{children}</code>",
  "    </pre>",
  "  );",
  "}",
  "",
  "export function CoverLayout({ title, subtitle, eyebrow }: { title: ReactNode; subtitle?: ReactNode; eyebrow?: string }) {",
  "  return (",
  '    <SlideFrame className="cover-layout">',
  '      <div className="cover-orb cover-orb-one" />',
  '      <div className="cover-orb cover-orb-two" />',
  '      {eyebrow && <Pill className="cover-pill">{eyebrow}</Pill>}',
  '      <h1 className="cover-title">{title}</h1>',
  '      {subtitle && <p className="cover-subtitle">{subtitle}</p>}',
  '      <div className="cover-wordmark">Cloudflare</div>',
  "    </SlideFrame>",
  "  );",
  "}",
  "",
  "export function SplitLayout({ eyebrow, title, body, visual }: { eyebrow?: string; title: ReactNode; body?: ReactNode; visual: ReactNode }) {",
  "  return (",
  "    <SlideFrame>",
  '      <SlideHeader eyebrow={eyebrow} title="Cloudflare" />',
  '      <div className="split-layout">',
  '        <div className="split-copy">',
  "          <BigTitle>{title}</BigTitle>",
  "          {body && <Lead>{body}</Lead>}",
  "        </div>",
  '        <div className="split-visual">{visual}</div>',
  "      </div>",
  "    </SlideFrame>",
  "  );",
  "}",
  "",
  "export function FeatureGridLayout({ eyebrow, title, subtitle, features }: { eyebrow?: string; title: ReactNode; subtitle?: ReactNode; features: Array<{ title: string; description: string }> }) {",
  "  return (",
  "    <SlideFrame>",
  '      <SlideHeader eyebrow={eyebrow} title="Cloudflare" />',
  "      <BigTitle>{title}</BigTitle>",
  "      {subtitle && <Lead>{subtitle}</Lead>}",
  '      <div className="feature-grid-layout">',
  "        {features.slice(0, 6).map((feature) => (",
  "          <FeatureCard key={feature.title} title={feature.title} description={feature.description} />",
  "        ))}",
  "      </div>",
  "    </SlideFrame>",
  "  );",
  "}",
  "",
  "export function StatHeroLayout({ eyebrow, title, stats }: { eyebrow?: string; title: ReactNode; stats: Array<{ value: string; label: string }> }) {",
  "  return (",
  "    <SlideFrame>",
  '      <SlideHeader eyebrow={eyebrow} title="Cloudflare" />',
  '      <div className="stat-hero-layout">',
  "        <BigTitle>{title}</BigTitle>",
  '        <div className="stat-hero-grid">',
  "          {stats.slice(0, 3).map((stat) => (",
  "            <Stat key={stat.value + stat.label} value={stat.value} label={stat.label} />",
  "          ))}",
  "        </div>",
  "      </div>",
  "    </SlideFrame>",
  "  );",
  "}",
  "",
  "export function TimelineLayout({ eyebrow, title, items }: { eyebrow?: string; title: ReactNode; items: Array<{ label: string; title: string; description: string }> }) {",
  "  return (",
  "    <SlideFrame>",
  '      <SlideHeader eyebrow={eyebrow} title="Cloudflare" />',
  "      <BigTitle>{title}</BigTitle>",
  '      <div className="timeline-layout">',
  "        {items.slice(0, 4).map((item, index) => (",
  '          <div className="timeline-item" key={item.label}>',
  '            <div className="timeline-index">{index + 1}</div>',
  '            <div className="timeline-label">{item.label}</div>',
  "            <h3>{item.title}</h3>",
  "            <p>{item.description}</p>",
  "          </div>",
  "        ))}",
  "      </div>",
  "    </SlideFrame>",
  "  );",
  "}",
  "",
  "export function ComparisonLayout({ eyebrow, title, left, right }: { eyebrow?: string; title: ReactNode; left: { label: string; title: string; points: string[] }; right: { label: string; title: string; points: string[] } }) {",
  "  return (",
  "    <SlideFrame>",
  '      <SlideHeader eyebrow={eyebrow} title="Cloudflare" />',
  "      <BigTitle>{title}</BigTitle>",
  '      <div className="comparison-layout">',
  "        {[left, right].map((column, index) => (",
  '          <Card className={index === 0 ? "comparison-card muted" : "comparison-card accent"} key={column.label}>',
  "            <Pill>{column.label}</Pill>",
  "            <h3>{column.title}</h3>",
  "            <ul>",
  "              {column.points.map((point) => (",
  "                <li key={point}>{point}</li>",
  "              ))}",
  "            </ul>",
  "          </Card>",
  "        ))}",
  "      </div>",
  "    </SlideFrame>",
  "  );",
  "}",
  "",
  "export function QuoteLayout({ quote, attribution, context }: { quote: ReactNode; attribution?: string; context?: string }) {",
  "  return (",
  '    <SlideFrame className="quote-layout">',
  '      <SlideHeader eyebrow="Perspective" title="Cloudflare" />',
  '      <blockquote className="quote-text">“{quote}”</blockquote>',
  '      {attribution && <p className="quote-attribution">{attribution}</p>}',
  '      {context && <p className="quote-context">{context}</p>}',
  "    </SlideFrame>",
  "  );",
  "}",
  "",
  "export function ProcessFlowLayout({ eyebrow, title, steps }: { eyebrow?: string; title: ReactNode; steps: Array<{ title: string; description: string }> }) {",
  "  return (",
  "    <SlideFrame>",
  '      <SlideHeader eyebrow={eyebrow} title="Cloudflare" />',
  "      <BigTitle>{title}</BigTitle>",
  '      <div className="process-flow-layout">',
  "        {steps.slice(0, 5).map((step, index) => (",
  '          <div className="process-step" key={step.title}>',
  '            <span className="process-step-number">{index + 1}</span>',
  "            <h3>{step.title}</h3>",
  "            <p>{step.description}</p>",
  "          </div>",
  "        ))}",
  "      </div>",
  "    </SlideFrame>",
  "  );",
  "}",
  ""
].join("\n");

const CF2026_COMPONENTS = [
  "import type { ReactNode } from 'react';",
  "import { CFIcon, type CFIconName } from './icons';",
  "",
  "const CF = {",
  "  orange: '#FF6633',",
  "  tangerine: '#F6821F',",
  "  ruby: '#FF6633',",
  "  black: '#000000',",
  "  white: '#FFFFFF',",
  "  muted: '#747474',",
  "  line: '#E6E6E6',",
  "  dawn: 'linear-gradient(90deg, #FF6633 0%, #F6821F 50%, #FBAD41 100%)'",
  "} as const;",
  "",
  "type FrameVariant = 'white' | 'orange' | 'white-with-flare';",
  "",
  "function flareBackground(variant: FrameVariant) {",
  "  if (variant === 'orange') {",
  "    return {",
  "      background:",
  "        'radial-gradient(circle at 74% 28%, rgba(255,255,255,0.24), transparent 25%), radial-gradient(circle at 18% 92%, rgba(251,173,65,0.72), transparent 34%), linear-gradient(135deg, #FF6633 0%, #F6821F 58%, #FBAD41 100%)'",
  "    };",
  "  }",
  "  if (variant === 'white-with-flare') {",
  "    return {",
  "      background:",
  "        'radial-gradient(circle at 92% 6%, rgba(255,102,51,0.34), transparent 30%), radial-gradient(circle at 88% 94%, rgba(251,173,65,0.24), transparent 28%), #FFFFFF'",
  "    };",
  "  }",
  "  return { background: CF.white };",
  "}",
  "",
  "export function CF2026Frame({ variant, children }: { variant: FrameVariant; children: ReactNode }) {",
  "  return (",
  "    <section data-slide-container className=\"cf2026-frame\" style={{ position: 'relative', width: 1200, height: 675, overflow: 'hidden', color: variant === 'orange' ? CF.white : CF.black, fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', ...flareBackground(variant) }}>",
  "      {children}",
  "    </section>",
  "  );",
  "}",
  "",
  "export function CF2026Logo({ white = false, placement = 'top-right' }: { white?: boolean; placement?: 'top-left' | 'top-right' }) {",
  "  return (",
  "    <img src={white ? '/logos/cloudflare-white.svg' : '/logos/cloudflare.svg'} alt=\"Cloudflare\" style={{ position: 'absolute', top: placement === 'top-left' ? 56 : 30, left: placement === 'top-left' ? 36 : undefined, right: placement === 'top-right' ? 37 : undefined, width: placement === 'top-left' ? 267 : 171, height: 'auto' }} />",
  "  );",
  "}",
  "",
  "function GradientBar() {",
  "  return <div style={{ position: 'absolute', bottom: 0, left: 0, width: '100%', height: 12, background: CF.dawn }} />;",
  "}",
  "",
  "function StandardHeader({ eyebrow, headline, maxLines = 2 }: { eyebrow?: string; headline: string; maxLines?: number }) {",
  "  return (",
  "    <>",
  "      <CF2026Logo />",
  "      {eyebrow && <div style={{ position: 'absolute', top: 35, left: 36, color: CF.ruby, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{eyebrow}</div>}",
  "      <h2 style={{ position: 'absolute', top: 76, left: 35, width: 984, margin: 0, color: CF.black, fontSize: 28, fontWeight: 600, lineHeight: 1.2, letterSpacing: '-0.03em', overflow: 'hidden', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: maxLines }}>{headline}</h2>",
  "    </>",
  "  );",
  "}",
  "",
  "export function CoverOrange({ title, subtitle }: { title: string; subtitle?: string }) {",
  "  return (",
  '    <CF2026Frame variant="orange">',
  '      <CF2026Logo white placement="top-left" />',
  "      <h1 style={{ position: 'absolute', top: 197, left: 33, width: 687, margin: 0, color: CF.white, fontSize: 58, fontWeight: 700, lineHeight: 1.1, letterSpacing: '-0.03em', whiteSpace: 'pre-line' }}>{title}</h1>",
  "      {subtitle && <div style={{ position: 'absolute', top: 533, left: 36, width: 553, color: CF.white, fontSize: 17, fontWeight: 600, lineHeight: 1.5, whiteSpace: 'pre-line' }}>{subtitle}</div>}",
  "    </CF2026Frame>",
  "  );",
  "}",
  "",
  "export function CoverWhite({ title, subtitle }: { title: string; subtitle?: string }) {",
  "  return (",
  '    <CF2026Frame variant="white-with-flare">',
  '      <CF2026Logo placement="top-left" />',
  "      <h1 style={{ position: 'absolute', top: 206, left: 36, width: 760, margin: 0, color: CF.black, fontSize: 58, fontWeight: 700, lineHeight: 1.08, letterSpacing: '-0.035em', whiteSpace: 'pre-line' }}>{title}</h1>",
  "      {subtitle && <div style={{ position: 'absolute', top: 528, left: 36, width: 650, color: CF.muted, fontSize: 18, fontWeight: 500, lineHeight: 1.45 }}>{subtitle}</div>}",
  "    </CF2026Frame>",
  "  );",
  "}",
  "",
  "export function DividerOrange({ title }: { title: string }) {",
  "  return (",
  '    <CF2026Frame variant="orange">',
  '      <CF2026Logo white placement="top-left" />',
  "      <h1 style={{ position: 'absolute', left: 82, right: 82, top: 272, margin: 0, color: CF.white, fontSize: 58, fontWeight: 700, lineHeight: 1.05, letterSpacing: '-0.045em', textAlign: 'center' }}>{title}</h1>",
  "    </CF2026Frame>",
  "  );",
  "}",
  "",
  "export function ContentColumns({ eyebrow, headline, columns }: { eyebrow?: string; headline: string; columns: Array<{ title?: string; body: ReactNode }> }) {",
  "  const count = Math.min(columns.length, 2);",
  "  return (",
  '    <CF2026Frame variant="white">',
  "      <StandardHeader eyebrow={eyebrow} headline={headline} />",
  "      <div style={{ position: 'absolute', top: 160, left: 36, width: 1128, display: 'grid', gridTemplateColumns: `repeat(${count}, 1fr)`, gap: 38 }}>",
  "        {columns.slice(0, count).map((column, i) => (",
  "          <div key={i} style={{ color: CF.black, fontSize: 19, lineHeight: 1.55 }}>",
  "            {column.title && <h3 style={{ margin: '0 0 14px', color: CF.orange, fontSize: 22, lineHeight: 1.2 }}>{column.title}</h3>}",
  "            <div>{column.body}</div>",
  "          </div>",
  "        ))}",
  "      </div>",
  "      <GradientBar />",
  "    </CF2026Frame>",
  "  );",
  "}",
  "",
  "export function StatsRow({ eyebrow, headline, count, stats }: { eyebrow?: string; headline: string; count: 2 | 3 | 4; stats: Array<{ value: string; label: string; description?: string }> }) {",
  "  const xs = count === 2 ? [34, 618] : count === 3 ? [34, 426, 819] : [34, 328, 622, 916];",
  "  const cellWidth = count === 2 ? 550 : count === 3 ? 343 : 260;",
  "  const valueSize = count === 2 ? 80 : count === 3 ? 72 : 60;",
  "  return (",
  '    <CF2026Frame variant="white">',
  "      <StandardHeader eyebrow={eyebrow} headline={headline} />",
  "      {stats.slice(0, count).map((item, i) => (",
  "        <div key={`${item.value}-${item.label}`}>",
  "          <div style={{ position: 'absolute', top: 302, left: (xs[i] ?? 0) + 3, width: cellWidth, height: 3, background: CF.tangerine }} />",
  "          <div style={{ position: 'absolute', top: 194, left: xs[i], width: cellWidth, color: CF.tangerine, fontSize: valueSize, fontWeight: 600, lineHeight: 1, letterSpacing: '-0.03em' }}>{item.value}</div>",
  "          <div style={{ position: 'absolute', top: 320, left: (xs[i] ?? 0) + 3, width: cellWidth, color: CF.black, fontSize: 16, fontWeight: 600, lineHeight: 1.3 }}>{item.label}</div>",
  "          {item.description && <div style={{ position: 'absolute', top: 360, left: (xs[i] ?? 0) + 3, width: cellWidth, color: CF.muted, fontSize: 15, lineHeight: 1.5 }}>{item.description}</div>}",
  "        </div>",
  "      ))}",
  "      <GradientBar />",
  "    </CF2026Frame>",
  "  );",
  "}",
  "",
  "export function IconsRow({ eyebrow, headline, count, items }: { eyebrow?: string; headline: string; count: 2 | 3 | 4; items: Array<{ icon: CFIconName; title: string; body: string }> }) {",
  "  const cols = items.slice(0, count);",
  "  return (",
  '    <CF2026Frame variant="white">',
  "      <StandardHeader eyebrow={eyebrow} headline={headline} />",
  "      <div style={{ position: 'absolute', top: 190, left: 36, width: 1128, display: 'grid', gridTemplateColumns: `repeat(${count}, 1fr)`, gap: 26 }}>",
  "        {cols.map((item) => (",
  "          <div key={item.title} style={{ borderTop: `3px solid ${CF.tangerine}`, paddingTop: 24 }}>",
  "            <CFIcon name={item.icon} size={46} />",
  "            <h3 style={{ margin: '24px 0 12px', fontSize: 22, lineHeight: 1.12 }}>{item.title}</h3>",
  "            <p style={{ margin: 0, color: CF.muted, fontSize: 16, lineHeight: 1.45 }}>{item.body}</p>",
  "          </div>",
  "        ))}",
  "      </div>",
  "      <GradientBar />",
  "    </CF2026Frame>",
  "  );",
  "}",
  "",
  "export function ListRow({ eyebrow, headline, count, columns }: { eyebrow?: string; headline: string; count: 2 | 3 | 4; columns: Array<{ title: string; bullets: string[] }> }) {",
  "  return (",
  '    <CF2026Frame variant="white">',
  "      <StandardHeader eyebrow={eyebrow} headline={headline} />",
  "      <div style={{ position: 'absolute', top: 176, left: 36, width: 1128, display: 'grid', gridTemplateColumns: `repeat(${count}, 1fr)`, gap: 22 }}>",
  "        {columns.slice(0, count).map((column) => (",
  "          <div key={column.title} style={{ border: `1px solid ${CF.line}`, borderRadius: 2, padding: 22, minHeight: 320 }}>",
  "            <h3 style={{ margin: '0 0 18px', color: CF.orange, fontSize: 21, lineHeight: 1.15 }}>{column.title}</h3>",
  "            <ul style={{ margin: 0, paddingLeft: 19, color: CF.black, fontSize: 16, lineHeight: 1.45 }}>",
  "              {column.bullets.map((bullet) => <li key={bullet} style={{ marginBottom: 10 }}>{bullet}</li>)}",
  "            </ul>",
  "          </div>",
  "        ))}",
  "      </div>",
  "      <GradientBar />",
  "    </CF2026Frame>",
  "  );",
  "}",
  "",
  "export function GridFull({ eyebrow, headline, content }: { eyebrow?: string; headline: string; content: ReactNode }) {",
  "  return (",
  '    <CF2026Frame variant="white">',
  "      <StandardHeader eyebrow={eyebrow} headline={headline} />",
  "      <div style={{ position: 'absolute', top: 160, left: 36, width: 1128, height: 460, overflow: 'hidden' }}>{content}</div>",
  "      <GradientBar />",
  "    </CF2026Frame>",
  "  );",
  "}",
  "",
  "export function GridCopyLeft({ eyebrow, headline, body, content }: { eyebrow?: string; headline: string; body: ReactNode; content: ReactNode }) {",
  "  return (",
  '    <CF2026Frame variant="white">',
  "      <StandardHeader eyebrow={eyebrow} headline={headline} />",
  "      <div style={{ position: 'absolute', top: 165, left: 36, width: 400, color: CF.black, fontSize: 18, lineHeight: 1.5 }}>{body}</div>",
  "      <div style={{ position: 'absolute', top: 160, left: 480, width: 684, height: 460, overflow: 'hidden' }}>{content}</div>",
  "      <GradientBar />",
  "    </CF2026Frame>",
  "  );",
  "}",
  "",
  "export function CopySidebarOrange({ headline, body, sidebarSubhead, sidebarBullets }: { headline: string; body: string | string[]; sidebarSubhead: string; sidebarBullets: string[] }) {",
  "  const bodyParagraphs = Array.isArray(body) ? body : [body];",
  "  return (",
  '    <CF2026Frame variant="white">',
  "      <div style={{ position: 'absolute', top: 0, right: 0, width: 440, height: 675, background: 'linear-gradient(180deg, #FF6633 0%, #F6821F 55%, #FBAD41 100%)', borderTopLeftRadius: 40 }} />",
  "      <img src=\"/logos/cloudflare-white.svg\" alt=\"Cloudflare\" style={{ position: 'absolute', top: 30, right: 37, width: 171, height: 'auto' }} />",
  "      <h2 style={{ position: 'absolute', top: 76, left: 36, width: 680, margin: 0, color: CF.black, fontSize: 28, fontWeight: 600, lineHeight: 1.2, letterSpacing: '-0.03em' }}>{headline}</h2>",
  "      <div style={{ position: 'absolute', top: 220, left: 36, width: 680, height: 400, color: CF.black, fontSize: 19, lineHeight: 1.55, display: 'flex', flexDirection: 'column', gap: 16, overflow: 'hidden' }}>",
  "        {bodyParagraphs.map((paragraph) => <p key={paragraph} style={{ margin: 0 }}>{paragraph}</p>)}",
  "      </div>",
  "      <div style={{ position: 'absolute', top: 200, right: 38, width: 360, color: CF.black, fontSize: 18, fontWeight: 700, lineHeight: 1.3 }}>{sidebarSubhead}</div>",
  "      <ul style={{ position: 'absolute', top: 240, right: 38, width: 360, margin: 0, padding: 0, listStyle: 'none', color: CF.black, fontSize: 17, lineHeight: 1.45, display: 'flex', flexDirection: 'column', gap: 8 }}>",
  "        {sidebarBullets.map((bullet) => <li key={bullet} style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}><span style={{ flexShrink: 0, width: 6, height: 6, borderRadius: '50%', background: CF.black, marginTop: 8 }} /><span>{bullet}</span></li>)}",
  "      </ul>",
  "    </CF2026Frame>",
  "  );",
  "}",
  "",
  "export function Timeline({ headline, periods, milestones }: { headline: string; periods: [string, string]; milestones: Array<{ label: string; body?: string }> }) {",
  "  const top = milestones.slice(0, 4);",
  "  const bottom = milestones.slice(4, 8);",
  "  const colX = (i: number) => 36 + i * 280;",
  "  const bottomX = (i: number) => 176 + i * 280;",
  "  const Item = ({ item, x, y, tickY, tickH }: { item: { label: string; body?: string }; x: number; y: number; tickY: number; tickH: number }) => (",
  "    <>",
  "      <div style={{ position: 'absolute', top: tickY, left: x, width: 2, height: tickH, background: CF.tangerine }} />",
  "      <div style={{ position: 'absolute', top: y, left: x + 12, width: 248, color: CF.black, fontSize: 17, fontWeight: 700, lineHeight: 1.25 }}>{item.label}</div>",
  "      {item.body && <div style={{ position: 'absolute', top: y + 40, left: x + 12, width: 248, color: CF.muted, fontSize: 13, lineHeight: 1.35 }}>{item.body}</div>}",
  "    </>",
  "  );",
  "  return (",
  '    <CF2026Frame variant="white">',
  "      <CF2026Logo />",
  "      <h2 style={{ position: 'absolute', top: 76, left: 36, width: 984, margin: 0, color: CF.black, fontSize: 28, fontWeight: 600, lineHeight: 1.2, letterSpacing: '-0.03em' }}>{headline}</h2>",
  "      {top.map((item, i) => <Item key={`top-${item.label}`} item={item} x={colX(i)} y={164} tickY={176} tickH={198} />)}",
  "      <div style={{ position: 'absolute', top: 354, left: 0, width: 1200, height: 44, background: CF.dawn, color: CF.white, fontSize: 20, fontWeight: 700 }}><span style={{ position: 'absolute', left: 36, top: 9 }}>{periods[0]}</span><span style={{ position: 'absolute', left: 636, top: 9 }}>{periods[1]}</span></div>",
  "      {bottom.map((item, i) => <Item key={`bottom-${item.label}`} item={item} x={bottomX(i)} y={520} tickY={398} tickH={198} />)}",
  "    </CF2026Frame>",
  "  );",
  "}",
  "",
  "export function ChartFull({ eyebrow, headline, chart }: { eyebrow?: string; headline: string; chart: ReactNode }) {",
  "  return <GridFull eyebrow={eyebrow} headline={headline} content={<div data-gslides-role=\"diagram\" data-pptx-screenshot=\"\" style={{ width: '100%', height: '100%' }}>{chart}</div>} />;",
  "}",
  "",
  "export function ChartCopyLeft({ eyebrow, headline, body, chart }: { eyebrow?: string; headline: string; body: ReactNode; chart: ReactNode }) {",
  "  return <GridCopyLeft eyebrow={eyebrow} headline={headline} body={body} content={<div data-gslides-role=\"diagram\" data-pptx-screenshot=\"\" style={{ width: '100%', height: '100%' }}>{chart}</div>} />;",
  "}",
  "",
  "export function ImageCopyA({ headline, body, image }: { headline: string; body: string; image: string }) {",
  "  return (",
  '    <CF2026Frame variant="white">',
  "      <StandardHeader headline={headline} />",
  "      <div style={{ position: 'absolute', top: 180, left: 36, width: 470, color: CF.black, fontSize: 20, lineHeight: 1.5 }}>{body}</div>",
  "      <img src={image} alt=\"\" style={{ position: 'absolute', top: 160, right: 36, width: 590, height: 430, objectFit: 'cover', borderRadius: 18 }} />",
  "      <GradientBar />",
  "    </CF2026Frame>",
  "  );",
  "}",
  "",
  "export function TableOfContents({ title = 'Agenda', items }: { title?: string; items: string[] }) {",
  "  return (",
  '    <CF2026Frame variant="white-with-flare">',
  "      <CF2026Logo />",
  "      <h1 style={{ position: 'absolute', top: 86, left: 70, width: 520, margin: 0, color: CF.black, fontSize: 48, lineHeight: 1.05, letterSpacing: '-0.04em' }}>{title}</h1>",
  "      <ol style={{ position: 'absolute', top: 184, left: 70, width: 760, margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 18 }}>",
  "        {items.slice(0, 6).map((item, i) => <li key={item} style={{ display: 'grid', gridTemplateColumns: '44px 1fr', alignItems: 'start', gap: 18, color: CF.black, fontSize: 24, lineHeight: 1.18 }}><span style={{ color: CF.orange, fontWeight: 700 }}>{String(i + 1).padStart(2, '0')}</span><span>{item}</span></li>)}",
  "      </ol>",
  "    </CF2026Frame>",
  "  );",
  "}",
  "",
  "export function ClientList({ headline, logos }: { headline: string; logos: string[] }) {",
  "  return (",
  '    <CF2026Frame variant="white">',
  "      <StandardHeader headline={headline} />",
  "      <div style={{ position: 'absolute', top: 172, left: 54, right: 54, display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 16 }}>",
  "        {logos.slice(0, 20).map((logo) => <div key={logo} style={{ height: 70, border: `1px solid ${CF.line}`, borderRadius: 999, display: 'grid', placeItems: 'center', color: CF.muted, fontSize: 18, fontWeight: 600 }}>{logo}</div>)}",
  "      </div>",
  "      <GradientBar />",
  "    </CF2026Frame>",
  "  );",
  "}",
  "",
  "export function QuoteLarge({ quote, attribution }: { quote: string; attribution?: string }) {",
  "  return (",
  '    <CF2026Frame variant="orange">',
  "      <CF2026Logo white />",
  "      <div aria-hidden=\"true\" style={{ position: 'absolute', top: 118, left: 83, color: 'rgba(255,255,255,0.72)', fontSize: 136, lineHeight: 1, fontWeight: 700 }}>“</div>",
  "      <blockquote style={{ position: 'absolute', top: 236, left: 83, width: 817, margin: 0, color: CF.white, fontSize: 40, fontWeight: 600, lineHeight: 1.25, letterSpacing: '-0.02em', whiteSpace: 'pre-line' }}>{quote}</blockquote>",
  "      {attribution && <div style={{ position: 'absolute', top: 515, left: 83, width: 592, color: CF.black, fontSize: 20, lineHeight: 1.4, whiteSpace: 'pre-line' }}>{attribution}</div>}",
  "    </CF2026Frame>",
  "  );",
  "}",
  "",
  "export function BigCopyWhite({ copy }: { copy: string }) {",
  "  return (",
  '    <CF2026Frame variant="white-with-flare">',
  "      <CF2026Logo />",
  "      <h1 style={{ position: 'absolute', top: 190, left: 84, width: 900, margin: 0, color: CF.black, fontSize: 54, lineHeight: 1.08, fontWeight: 600, letterSpacing: '-0.045em', whiteSpace: 'pre-line' }}>{copy}</h1>",
  "    </CF2026Frame>",
  "  );",
  "}",
  "",
  "export function Closing({ title = 'Thank you', contactInfo, copyright }: { title?: string; contactInfo?: string; copyright?: string }) {",
  "  return (",
  '    <CF2026Frame variant="orange">',
  '      <CF2026Logo white placement="top-left" />',
  "      <h1 style={{ position: 'absolute', left: 80, top: 242, margin: 0, color: CF.white, fontSize: 70, lineHeight: 1, letterSpacing: '-0.055em' }}>{title}</h1>",
  "      {contactInfo && <div style={{ position: 'absolute', left: 84, top: 390, color: CF.white, fontSize: 22, lineHeight: 1.4, whiteSpace: 'pre-line' }}>{contactInfo}</div>}",
  "      {copyright && <div style={{ position: 'absolute', left: 84, bottom: 54, color: 'rgba(255,255,255,0.72)', fontSize: 13 }}>{copyright}</div>}",
  "    </CF2026Frame>",
  "  );",
  "}",
  ""
].join("\n");

const ICON_COMPONENTS = [
  "export type CFIconName = keyof typeof iconFiles;",
  "",
  "const iconFiles = {",
  "  workers: 'cloudflare-workers_outline.svg',",
  "  'durable-objects': 'cloudflare-durable-objects_outline.svg',",
  "  kv: 'cloudflare-kv_outline.svg',",
  "  ai: 'innovation-intelligence_outline.svg',",
  "  storage: 'server-database_outline.svg',",
  "  security: 'security-shield-protection-1_outline.svg',",
  "  code: 'code-brackets_outline.svg',",
  "  network: 'network-scale_outline.svg',",
  "  browser: 'internet-browser_outline.svg',",
  "  database: 'server-database_outline.svg',",
  "  github: 'logo-github_regular.svg',",
  "  warning: 'warning_outline.svg'",
  "};",
  "",
  "const labels: Record<CFIconName, string> = {",
  "  workers: 'Workers',",
  "  'durable-objects': 'Durable Objects',",
  "  kv: 'KV',",
  "  ai: 'AI',",
  "  storage: 'Storage',",
  "  security: 'Security',",
  "  code: 'Code',",
  "  network: 'Network',",
  "  browser: 'Browser',",
  "  database: 'Database',",
  "  github: 'GitHub',",
  "  warning: 'Warning'",
  "};",
  "",
  "export const CF_ICON_NAMES = Object.keys(iconFiles) as CFIconName[];",
  "",
  "export function cfIconUrl(name: CFIconName) {",
  "  return `/cf-icons/${iconFiles[name] ?? iconFiles.warning}`;",
  "}",
  "",
  "export function CFIcon({ name, size = 32 }: { name: CFIconName; size?: number }) {",
  "  const label = labels[name];",
  "  return <img src={cfIconUrl(name)} alt={label} width={size} height={size} />;",
  "}",
  ""
].join("\n");

const DIAGRAM_COMPONENTS = [
  "import type { ReactNode } from 'react';",
  "",
  "export function FlowDiagram({ children }: { children: ReactNode }) {",
  "  return <div data-gslides-role=\"diagram\" style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 18 }}>{children}</div>;",
  "}",
  "",
  "export function FlowNode({ title, label, tone = 'orange' }: { title: string; label?: string; tone?: 'orange' | 'blue' | 'green' | 'purple' }) {",
  "  const color = tone === 'blue' ? '#0A95FF' : tone === 'green' ? '#19B006' : tone === 'purple' ? '#9333EA' : '#FF6633';",
  "  return <div style={{ width: 168, minHeight: 112, borderRadius: 18, border: `2px dashed ${color}`, background: '#FFFDFB', color, padding: 18, textAlign: 'center', display: 'grid', placeItems: 'center' }}><div><strong style={{ display: 'block', color, fontSize: 20, lineHeight: 1.1 }}>{title}</strong>{label && <span style={{ display: 'block', marginTop: 8, color: '#7B6254', fontSize: 13 }}>{label}</span>}</div></div>;",
  "}",
  "",
  "export function FlowArrow() {",
  "  return <div aria-hidden=\"true\" style={{ color: '#F6821F', fontSize: 34, fontWeight: 800 }}>→</div>;",
  "}",
  "",
  "export function TerminalMockup({ title = 'terminal', lines }: { title?: string; lines: string[] }) {",
  "  return <div style={{ width: '100%', borderRadius: 16, overflow: 'hidden', background: '#2D1B14', color: '#FFF7ED', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', boxShadow: '0 18px 36px rgba(45,27,20,0.22)' }}><div style={{ padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.12)', color: '#FBAD41', fontSize: 13 }}>{title}</div><div style={{ padding: 18, fontSize: 17, lineHeight: 1.5 }}>{lines.map((line) => <div key={line}><span style={{ color: '#26A641' }}>$</span> {line}</div>)}</div></div>;",
  "}",
  "",
  "export function BrowserMockup({ title = 'Preview', children }: { title?: string; children: ReactNode }) {",
  "  return <div style={{ width: '100%', borderRadius: 18, overflow: 'hidden', border: '1px solid #EBD5C1', background: '#FFFDFB', boxShadow: '0 16px 36px rgba(82,16,0,0.10)' }}><div style={{ height: 42, display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px', borderBottom: '1px solid #EBD5C1', color: '#7B6254', fontSize: 13 }}><span style={{ width: 10, height: 10, borderRadius: 999, background: '#FF6633' }} /><span style={{ width: 10, height: 10, borderRadius: 999, background: '#FBAD41' }} /><span style={{ width: 10, height: 10, borderRadius: 999, background: '#19B006' }} /><span style={{ marginLeft: 8 }}>{title}</span></div><div style={{ padding: 20 }}>{children}</div></div>;",
  "}",
  "",
  "export function DiffBlock({ before, after }: { before: string[]; after: string[] }) {",
  "  return <div style={{ width: '100%', borderRadius: 14, overflow: 'hidden', border: '1px solid #EBD5C1', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 15 }}>{before.map((line) => <div key={`b-${line}`} style={{ padding: '8px 12px', color: '#A01818', background: '#FFF1F1' }}>- {line}</div>)}{after.map((line) => <div key={`a-${line}`} style={{ padding: '8px 12px', color: '#137333', background: '#F0FFF1' }}>+ {line}</div>)}</div>;",
  "}",
  ""
].join("\n");

const DEFAULT_STYLES = [
  ":root {",
  "  --cf-orange: #ff6633;",
  "  --cf-orange-mid: #f6821f;",
  "  --cf-orange-light: #ff663310;",
  "  --cf-text: #521000;",
  "  --cf-text-muted: #52100099;",
  "  --cf-text-subtle: #52100060;",
  "  --cf-bg-page: #f5f1eb;",
  "  --cf-bg-content: #fffbf5;",
  "  --cf-bg-card: #fffdfb;",
  "  --cf-bg-active: #fef7ed;",
  "  --cf-border: #ebd5c1;",
  "  --cf-border-light: #ebd5c180;",
  "  --cf-blue: #0a95ff;",
  "  --cf-green: #19b006;",
  "  --cf-purple: #9333ea;",
  "  --font-display: 'FT Kunst Grotesk', Inter, ui-sans-serif, system-ui, sans-serif;",
  "  --font-body: Inter, ui-sans-serif, system-ui, sans-serif;",
  "  --font-mono: 'Apercu Mono Pro', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;",
  "  font-family: var(--font-display);",
  "  color: var(--cf-text);",
  "  background: var(--cf-bg-page);",
  "}",
  "",
  "* { box-sizing: border-box; }",
  "body { margin: 0; font-family: var(--font-display); -webkit-font-smoothing: antialiased; }",
  "code { font-family: var(--font-mono); }",
  "",
  ".deck-shell {",
  "  min-height: 100vh;",
  "  display: flex;",
  "  align-items: center;",
  "  justify-content: center;",
  "  padding: 24px 24px 72px;",
  "  overflow: hidden;",
  "}",
  "",
  ".slide-viewport {",
  "  position: relative;",
  "  filter: drop-shadow(0 28px 70px rgba(82, 16, 0, 0.18));",
  "  flex: none;",
  "}",
  "",
  ".slide-stage {",
  "  position: absolute;",
  "  left: 0;",
  "  top: 0;",
  "  width: 1200px;",
  "  height: 675px;",
  "  transform-origin: top left;",
  "}",
  "",
  ".slide-frame {",
  "  position: relative;",
  "  width: 100%;",
  "  height: 100%;",
  "  overflow: hidden;",
  "  background:",
  "    radial-gradient(circle at 92% 10%, rgba(246, 130, 31, 0.20), transparent 30%),",
  "    radial-gradient(circle at 8% 92%, rgba(10, 149, 255, 0.10), transparent 34%),",
  "    var(--cf-bg-page);",
  "  border-radius: 0;",
  "}",
  "",
  ".slide-frame::before {",
  "  content: '';",
  "  position: absolute;",
  "  inset: 0;",
  "  opacity: 0.22;",
  "  background-image: radial-gradient(var(--cf-border) 1px, transparent 1px);",
  "  background-size: 18px 18px;",
  "}",
  "",
  ".slide-frame-inner {",
  "  position: absolute;",
  "  inset: 16px;",
  "  border-radius: 24px;",
  "  background: var(--cf-bg-content);",
  "  border: 1px solid var(--cf-border-light);",
  "}",
  "",
  ".slide-content {",
  "  position: absolute;",
  "  inset: 16px;",
  "  z-index: 1;",
  "  padding: 48px;",
  "  display: flex;",
  "  flex-direction: column;",
  "  overflow: hidden;",
  "}",
  "",
  ".slide-header {",
  "  display: flex;",
  "  align-items: center;",
  "  justify-content: space-between;",
  "  gap: 24px;",
  "  margin-bottom: 36px;",
  "}",
  "",
  ".slide-header-left {",
  "  display: flex;",
  "  align-items: center;",
  "  gap: 14px;",
  "}",
  "",
  ".product-name {",
  "  color: var(--cf-text);",
  "  font-size: 22px;",
  "  font-weight: 650;",
  "}",
  "",
  ".cloudflare-mark {",
  "  color: var(--cf-orange);",
  "  font-size: 16px;",
  "  font-weight: 700;",
  "  letter-spacing: -0.02em;",
  "}",
  "",
  ".eyebrow {",
  "  color: var(--cf-orange-mid);",
  "  display: inline-flex;",
  "  align-self: flex-start;",
  "  font-weight: 700;",
  "  letter-spacing: 0.12em;",
  "  text-transform: uppercase;",
  "  margin: 0 0 24px;",
  "}",
  "",
  ".big-title {",
  "  font-size: clamp(48px, 7vw, 92px);",
  "  line-height: 0.95;",
  "  letter-spacing: -0.06em;",
  "  margin: 0;",
  "  max-width: 860px;",
  "  color: var(--cf-text);",
  "}",
  "",
  ".lead {",
  "  color: var(--cf-text-muted);",
  "  font-size: clamp(22px, 2.4vw, 34px);",
  "  line-height: 1.2;",
  "  margin: 32px 0 0;",
  "  max-width: 760px;",
  "}",
  "",
  ".pill {",
  "  display: inline-flex;",
  "  align-items: center;",
  "  width: fit-content;",
  "  border-radius: 999px;",
  "  border: 1px solid var(--cf-border);",
  "  background: var(--cf-orange-light);",
  "  color: var(--cf-orange-mid);",
  "  padding: 7px 12px;",
  "  font-size: 14px;",
  "  font-weight: 650;",
  "}",
  "",
  ".card-grid {",
  "  display: grid;",
  "  grid-template-columns: repeat(3, minmax(0, 1fr));",
  "  gap: 18px;",
  "  margin-top: 42px;",
  "}",
  "",
  ".card {",
  "  border-radius: 22px;",
  "  border: 1px solid var(--cf-border);",
  "  background: var(--cf-bg-card);",
  "  box-shadow: 0 12px 30px rgba(82, 16, 0, 0.08);",
  "}",
  "",
  ".feature-card { padding: 24px; min-height: 150px; }",
  ".card-title { color: var(--cf-text); font-size: 22px; line-height: 1.05; margin: 0 0 10px; }",
  ".card-copy { color: var(--cf-text-muted); font-size: 16px; line-height: 1.35; margin: 0; }",
  "",
  ".stat-row {",
  "  display: grid;",
  "  grid-template-columns: repeat(3, minmax(0, 1fr));",
  "  gap: 18px;",
  "  margin-top: 42px;",
  "}",
  "",
  ".stat {",
  "  border-radius: 22px;",
  "  background: var(--cf-bg-active);",
  "  border: 1px dashed var(--cf-border);",
  "  padding: 22px 24px;",
  "}",
  "",
  ".stat strong { display: block; color: var(--cf-orange); font-size: 48px; line-height: 1; letter-spacing: -0.05em; }",
  ".stat span { display: block; color: var(--cf-text-muted); font-size: 15px; margin-top: 8px; }",
  "",
  ".code-block {",
  "  margin: 32px 0 0;",
  "  padding: 22px;",
  "  border-radius: 20px;",
  "  background: #2d1b14;",
  "  color: #fff7ed;",
  "  font-family: var(--font-mono);",
  "  font-size: 18px;",
  "  line-height: 1.55;",
  "  box-shadow: 0 18px 36px rgba(45, 27, 20, 0.22);",
  "  white-space: pre-wrap;",
  "}",
  "",
  ".code-filename {",
  "  display: block;",
  "  color: #fbad41;",
  "  font-size: 13px;",
  "  margin-bottom: 10px;",
  "}",
  "",
  ".cover-layout .slide-content {",
  "  justify-content: center;",
  "}",
  "",
  ".cover-orb {",
  "  position: absolute;",
  "  border-radius: 999px;",
  "  filter: blur(2px);",
  "  opacity: 0.7;",
  "}",
  "",
  ".cover-orb-one {",
  "  width: 360px;",
  "  height: 360px;",
  "  right: -80px;",
  "  top: -70px;",
  "  background: rgba(255, 102, 51, 0.18);",
  "}",
  "",
  ".cover-orb-two {",
  "  width: 300px;",
  "  height: 300px;",
  "  left: -80px;",
  "  bottom: -90px;",
  "  background: rgba(10, 149, 255, 0.12);",
  "}",
  "",
  ".cover-pill { margin-bottom: 28px; }",
  ".cover-title { color: var(--cf-text); font-size: 82px; line-height: 0.96; letter-spacing: -0.065em; max-width: 840px; margin: 0; font-weight: 900; }",
  ".cover-subtitle { color: var(--cf-orange-mid); font-size: 30px; line-height: 1.16; max-width: 760px; margin: 32px 0 0; font-weight: 750; }",
  ".cover-wordmark { position: absolute; right: 60px; top: 58px; color: var(--cf-orange); font-size: 20px; font-weight: 800; }",
  "",
  ".split-layout {",
  "  display: grid;",
  "  grid-template-columns: 0.95fr 1.05fr;",
  "  gap: 36px;",
  "  min-height: 0;",
  "  flex: 1;",
  "  align-items: center;",
  "}",
  "",
  ".split-copy .big-title { font-size: 58px; max-width: 520px; }",
  ".split-copy .lead { font-size: 25px; }",
  ".split-visual { min-height: 360px; border-radius: 28px; background: var(--cf-bg-card); border: 1px solid var(--cf-border); box-shadow: 0 18px 44px rgba(82, 16, 0, 0.10); padding: 28px; display: flex; align-items: center; justify-content: center; }",
  "",
  ".feature-grid-layout {",
  "  display: grid;",
  "  grid-template-columns: repeat(3, minmax(0, 1fr));",
  "  gap: 16px;",
  "  margin-top: 30px;",
  "}",
  "",
  ".feature-grid-layout .feature-card { min-height: 128px; }",
  "",
  ".stat-hero-layout { flex: 1; display: flex; flex-direction: column; justify-content: center; }",
  ".stat-hero-layout .big-title { max-width: 980px; }",
  ".stat-hero-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 22px; margin-top: 50px; }",
  ".stat-hero-grid .stat { min-height: 150px; }",
  ".stat-hero-grid .stat strong { font-size: 72px; }",
  ".stat-hero-grid .stat span { font-size: 18px; }",
  "",
  ".timeline-layout {",
  "  position: relative;",
  "  display: grid;",
  "  grid-template-columns: repeat(4, minmax(0, 1fr));",
  "  gap: 18px;",
  "  margin-top: 42px;",
  "}",
  "",
  ".timeline-layout::before { content: ''; position: absolute; left: 8%; right: 8%; top: 24px; height: 2px; background: var(--cf-border); }",
  ".timeline-item { position: relative; border-radius: 22px; border: 1px dashed var(--cf-border); background: var(--cf-bg-card); padding: 54px 20px 22px; min-height: 230px; }",
  ".timeline-index { position: absolute; top: 8px; left: 20px; width: 34px; height: 34px; border-radius: 999px; background: var(--cf-orange); color: white; display: grid; place-items: center; font-weight: 800; }",
  ".timeline-label { color: var(--cf-orange-mid); font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; }",
  ".timeline-item h3 { margin: 8px 0 10px; color: var(--cf-text); font-size: 24px; line-height: 1.05; }",
  ".timeline-item p { margin: 0; color: var(--cf-text-muted); font-size: 15px; line-height: 1.35; }",
  "",
  ".comparison-layout { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; margin-top: 36px; }",
  ".comparison-card { padding: 28px; min-height: 310px; }",
  ".comparison-card.accent { border-color: rgba(255, 102, 51, 0.45); background: var(--cf-bg-active); }",
  ".comparison-card.muted { background: rgba(255, 253, 251, 0.72); }",
  ".comparison-card h3 { margin: 22px 0 18px; color: var(--cf-text); font-size: 32px; line-height: 1.05; }",
  ".comparison-card ul { margin: 0; padding-left: 20px; color: var(--cf-text-muted); font-size: 19px; line-height: 1.45; }",
  ".comparison-card li + li { margin-top: 10px; }",
  "",
  ".quote-layout .slide-content { justify-content: center; }",
  ".quote-text { margin: 0; max-width: 900px; color: var(--cf-text); font-size: 60px; line-height: 1.02; letter-spacing: -0.055em; font-weight: 850; }",
  ".quote-attribution { color: var(--cf-orange-mid); font-size: 22px; font-weight: 800; margin: 34px 0 0; }",
  ".quote-context { color: var(--cf-text-muted); font-size: 18px; margin: 12px 0 0; max-width: 640px; }",
  "",
  ".process-flow-layout { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin-top: 42px; }",
  ".process-step { position: relative; min-height: 230px; border-radius: 22px; border: 1px solid var(--cf-border); background: var(--cf-bg-card); padding: 24px 18px 20px; }",
  ".process-step::after { content: '→'; position: absolute; right: -14px; top: 50%; transform: translateY(-50%); color: var(--cf-orange-mid); font-size: 28px; font-weight: 800; z-index: 2; }",
  ".process-step:last-child::after { content: ''; }",
  ".process-step-number { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 999px; background: var(--cf-orange-light); color: var(--cf-orange-mid); font-weight: 850; }",
  ".process-step h3 { color: var(--cf-text); font-size: 21px; line-height: 1.05; margin: 18px 0 10px; }",
  ".process-step p { color: var(--cf-text-muted); font-size: 14px; line-height: 1.35; margin: 0; }",
  "",
  ".deck-nav {",
  "  position: fixed;",
  "  bottom: 20px;",
  "  left: 50%;",
  "  transform: translateX(-50%);",
  "  display: flex;",
  "  gap: 8px;",
  "}",
  "",
  ".deck-nav a {",
  "  color: var(--cf-text-muted);",
  "  background: rgba(255, 255, 255, 0.84);",
  "  border: 1px solid var(--cf-border);",
  "  border-radius: 999px;",
  "  padding: 6px 10px;",
  "  text-decoration: none;",
  "}",
  "",
  ".deck-nav a.active {",
  "  color: white;",
  "  background: var(--cf-orange-mid);",
  "}",
  ""
].join("\n");

const DEFAULT_SLIDE = [
  "import { CoverOrange } from '../cf2026';",
  "",
  "export default function Slide() {",
  "  return (",
  '    <CoverOrange title="Think Slide Deck" subtitle="A container-free Let It Slide replacement path using Think, Shell Workspace, and Worker Bundler." />',
  "  );",
  "}",
  ""
].join("\n");

const DEFAULT_SLIDE_TWO = [
  "import { GridCopyLeft } from '../cf2026';",
  "import { FlowArrow, FlowDiagram, FlowNode } from '../diagrams';",
  "",
  "export default function Slide() {",
  "  return (",
  "    <GridCopyLeft",
  '      eyebrow="Architecture"',
  '      headline="The OpenCode container loop becomes a Workers-native generation loop"',
  "      body={",
  "        <p>",
  "          Think owns the conversation and tools, Shell Workspace stores source",
  "          files durably, and Worker Bundler turns those files into a live preview.",
  "        </p>",
  "      }",
  "      content={",
  "        <FlowDiagram>",
  '          <FlowNode title="Think" label="chat + tools" tone="orange" />',
  "          <FlowArrow />",
  '          <FlowNode title="Workspace" label="durable files" tone="blue" />',
  "          <FlowArrow />",
  '          <FlowNode title="Preview" label="worker bundle" tone="green" />',
  "        </FlowDiagram>",
  "      }",
  "    />",
  "  );",
  "}",
  ""
].join("\n");

const DEFAULT_SLIDE_THREE = [
  "import { StatsRow } from '../cf2026';",
  "",
  "export default function Slide() {",
  "  return (",
  "    <StatsRow",
  '      eyebrow="Replacement goals"',
  '      headline="What we keep from Let It Slide while removing the container dependency"',
  "      count={3}",
  "      stats={[",
  '        { value: "0", label: "containers", description: "No Linux sandbox or Vite server is required for authoring or preview." },',
  '        { value: "1", label: "durable workspace", description: "Slide source, style guides, icons, and components live with the agent." },',
  '        { value: "2", label: "visual systems", description: "Use workers.dev for expressive product decks or cf2026 for corporate fidelity." }',
  "      ]}",
  "    />",
  "  );",
  "}",
  ""
].join("\n");

const DEFAULT_SLIDE_FOUR = [
  "import { FeatureGridLayout } from '../components';",
  "",
  "export default function Slide() {",
  "  return (",
  "    <FeatureGridLayout",
  '      eyebrow="Ported surface area"',
  '      title="The generated workspace now starts with the pieces that made Let It Slide expressive"',
  '      subtitle="The model can choose from official-style templates, workers.dev layouts, branded icons, diagram mockups, and reference recipes."',
  "      features={[",
  '        { title: "Corporate layouts", description: "Cover, stats, content columns, icon rows, grids, quotes, and closing slides." },',
  '        { title: "Developer visuals", description: "Flow diagrams, terminal mockups, browser frames, and diff blocks." },',
  '        { title: "Authoring guidance", description: "Style-mode selection, deck recipes, overflow rules, and design principles." }',
  "      ]}",
  "    />",
  "  );",
  "}",
  ""
].join("\n");

const STYLE_GUIDE = [
  "# Slide Style Guide",
  "",
  "Use the Let It Slide workers.dev visual language:",
  "",
  "- Canvas is 1200x675 with an inset cream content area.",
  "- Prefer warm Cloudflare colors: orange accents, cream backgrounds, brown text.",
  "- Keep one clear idea per slide. Use diagrams, cards, stats, or code when they communicate faster than prose.",
  "- Use the components from `../components`: `SlideFrame`, `SlideHeader`, `Pill`, `BigTitle`, `Lead`, `FeatureCard`, `Stat`, and `CodeBlock`.",
  "- For official Cloudflare-deck fidelity, use components from `../cf2026`: `CoverOrange`, `CoverWhite`, `DividerOrange`, `ContentColumns`, `StatsRow`, `IconsRow`, `ListRow`, `GridFull`, `GridCopyLeft`, `QuoteLarge`, `BigCopyWhite`, and `Closing`.",
  "- More `../cf2026` layouts are available for replacement fidelity: `CopySidebarOrange`, `Timeline`, `ChartFull`, `ChartCopyLeft`, `ImageCopyA`, `TableOfContents`, and `ClientList`.",
  "- For architecture, CLI, browser, and before/after visuals, use `../diagrams`: `FlowDiagram`, `FlowNode`, `FlowArrow`, `TerminalMockup`, `BrowserMockup`, and `DiffBlock`.",
  "- For branded pictograms, use `CFIcon` from `../icons`. Only use the exported `CFIconName` values; do not invent icon names.",
  "- Prefer varied prebuilt layouts when they fit: `CoverLayout`, `SplitLayout`, `FeatureGridLayout`, `StatHeroLayout`, `TimelineLayout`, `ComparisonLayout`, `QuoteLayout`, and `ProcessFlowLayout`.",
  "- Do not make every slide a title + lead + three cards. Use a different layout for each distinct story beat.",
  "- Keep content inside the safe zone. Three cards per row is the maximum for comfortable spacing.",
  "- Avoid stretched pills or badges. Small inline elements should hug their content.",
  "- Code blocks should stay short, ideally 4-6 lines.",
  "",
  "Layout examples:",
  "",
  "```tsx",
  "import { ComparisonLayout, CoverLayout, StatHeroLayout, TimelineLayout } from '../components';",
  "",
  "// CoverLayout: strong opener",
  '<CoverLayout eyebrow="Launch" title="One idea, shown clearly" subtitle="Use the visual to carry the story." />',
  "",
  "// TimelineLayout: sequence or migration story",
  '<TimelineLayout title="From prompt to preview" items={[',
  "  { label: 'Ask', title: 'Describe the deck', description: 'The user gives the story and audience.' },",
  "  { label: 'Author', title: 'Write slides', description: 'Think edits durable React slide files.' },",
  "  { label: 'Bundle', title: 'Build preview', description: 'Worker Bundler turns files into a live app.' },",
  "]} />",
  "",
  "// ComparisonLayout: before/after or tradeoffs",
  '<ComparisonLayout title="Container vs Workspace" left={{ label: "Before", title: "Container runtime", points: ["Vite server", "OpenCode iframe"] }} right={{ label: "After", title: "Durable workspace", points: ["Think tools", "Worker preview"] }} />',
  "",
  "// StatHeroLayout: proof points",
  '<StatHeroLayout title="Why it works" stats={[{ value: "0", label: "containers" }, { value: "1", label: "durable workspace" }, { value: "100%", label: "Workers-native" }]} />',
  "```",
  "",
  "Read `/REFERENCE_SLIDES.md` before creating a multi-slide deck. It contains Let It Slide-inspired recipes and when to choose each visual system.",
  ""
].join("\n");

const REFERENCE_SLIDES = [
  "# Reference Slide Recipes",
  "",
  "Use this as few-shot guidance when choosing layouts. These are not rules; they are patterns from Let It Slide that help decks feel designed rather than templated.",
  "",
  "## Style Modes",
  "",
  "- `workers.dev`: expressive product storytelling, architecture diagrams, code snippets, browser and terminal mockups, warm cream/orange palette.",
  "- `cf2026`: official Cloudflare corporate deck fidelity, fixed positioning, orange/white covers, gradient bars, structured content regions.",
  "",
  "If the user asks for an official/customer/executive deck, use `cf2026`. If they ask for a developer/product/update deck, use `workers.dev` unless they say otherwise.",
  "",
  "## Deck Shape",
  "",
  "A strong generated deck usually mixes:",
  "",
  "1. Cover or thesis slide.",
  "2. Problem or shift slide.",
  "3. Architecture/flow/code proof slide.",
  "4. Benefits or proof points slide.",
  "5. Closing or next-step slide.",
  "",
  "## Recipes",
  "",
  "- Cover: `CoverOrange` / `CoverWhite` / `CoverLayout`.",
  "- Section break: `DividerOrange` or `BigCopyWhite`.",
  "- Agenda: `TableOfContents`.",
  "- Feature group: `FeatureGridLayout`, `IconsRow`, or `GridFull` with cards.",
  "- Proof points: `StatsRow` or `StatHeroLayout`.",
  "- Executive/sidebar story: `CopySidebarOrange`.",
  "- Before/after: `ComparisonLayout`, `GridFull` with two panels, or `DiffBlock`.",
  "- Timeline: `Timeline` for official-style 8-step sequences or `TimelineLayout` for workers.dev sequences.",
  "- Workflow: `ProcessFlowLayout` or `FlowDiagram` with `FlowNode` and `FlowArrow`.",
  "- Chart/image slot: `ChartFull`, `ChartCopyLeft`, or `ImageCopyA`.",
  "- Customer proof: `ClientList`.",
  "- Developer proof: `CodeBlock`, `TerminalMockup`, `BrowserMockup`, or `DiffBlock`.",
  "- Quote or point of view: `QuoteLarge`, `QuoteLayout`, or `BigCopyWhite`.",
  "",
  "## Design Rules Worth Preserving",
  "",
  "- Clarity over consistency. Break a pattern when another visual explains the idea faster.",
  "- Show, don't tell. Prefer diagrams, code, stats, and before/after visuals over long prose.",
  "- Earn attention. Remove anything that does not change the viewer's understanding.",
  "- Start with the story. Pick the layout after deciding the one thing the slide must teach.",
  "- Never stretch pills or badges. Their parent container should align to `flex-start`, `center`, or `flex-end`.",
  "- Keep code real and short. Made-up APIs reduce trust.",
  "- Check the bottom edge. Overflow is the most common slide failure.",
  ""
].join("\n");

const INDEX_HTML = [
  "<!doctype html>",
  '<html lang="en">',
  "  <head>",
  '    <meta charset="UTF-8" />',
  '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
  "    <title>Think Slide Deck Preview</title>",
  '    <link rel="stylesheet" href="styles.css" />',
  "  </head>",
  "  <body>",
  '    <div id="root"></div>',
  '    <script type="module" src="client.js"></script>',
  "  </body>",
  "</html>",
  ""
].join("\n");

const PREVIEW_ASSETS: Record<string, string> = {
  "/logos/cloudflare.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="66" height="30" viewBox="0 0 66 30" fill="none"><path fill="#FF6633" d="M52.688 13.028c-.22 0-.437.008-.654.015a.3.3 0 0 0-.102.024.37.37 0 0 0-.236.255l-.93 3.249c-.401 1.397-.252 2.687.422 3.634.618.876 1.646 1.39 2.894 1.45l5.045.306a.45.45 0 0 1 .435.41.5.5 0 0 1-.025.223.64.64 0 0 1-.547.426l-5.242.306c-2.848.132-5.912 2.456-6.987 5.29l-.378 1a.28.28 0 0 0 .248.382h18.054a.48.48 0 0 0 .464-.35c.32-1.153.482-2.344.48-3.54 0-7.22-5.79-13.072-12.933-13.072M44.807 29.578l.334-1.175c.402-1.397.253-2.687-.42-3.634-.62-.876-1.647-1.39-2.896-1.45l-23.665-.306a.47.47 0 0 1-.374-.199.5.5 0 0 1-.052-.434.64.64 0 0 1 .552-.426l23.886-.306c2.836-.131 5.9-2.456 6.975-5.29l1.362-3.6a.9.9 0 0 0 .04-.477C48.997 5.259 42.789 0 35.367 0c-6.842 0-12.647 4.462-14.73 10.665a6.92 6.92 0 0 0-4.911-1.374c-3.28.33-5.92 3.002-6.246 6.318a7.2 7.2 0 0 0 .18 2.472C4.3 18.241 0 22.679 0 28.133q0 .74.106 1.453a.46.46 0 0 0 .457.402h43.704a.57.57 0 0 0 .54-.418"/></svg>`,
  "/logos/cloudflare-white.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="66" height="30" viewBox="0 0 66 30" fill="none"><path fill="#fffbf5" d="M52.688 13.028c-.22 0-.437.008-.654.015a.3.3 0 0 0-.102.024.37.37 0 0 0-.236.255l-.93 3.249c-.401 1.397-.252 2.687.422 3.634.618.876 1.646 1.39 2.894 1.45l5.045.306a.45.45 0 0 1 .435.41.5.5 0 0 1-.025.223.64.64 0 0 1-.547.426l-5.242.306c-2.848.132-5.912 2.456-6.987 5.29l-.378 1a.28.28 0 0 0 .248.382h18.054a.48.48 0 0 0 .464-.35c.32-1.153.482-2.344.48-3.54 0-7.22-5.79-13.072-12.933-13.072M44.807 29.578l.334-1.175c.402-1.397.253-2.687-.42-3.634-.62-.876-1.647-1.39-2.896-1.45l-23.665-.306a.47.47 0 0 1-.374-.199.5.5 0 0 1-.052-.434.64.64 0 0 1 .552-.426l23.886-.306c2.836-.131 5.9-2.456 6.975-5.29l1.362-3.6a.9.9 0 0 0 .04-.477C48.997 5.259 42.789 0 35.367 0c-6.842 0-12.647 4.462-14.73 10.665a6.92 6.92 0 0 0-4.911-1.374c-3.28.33-5.92 3.002-6.246 6.318a7.2 7.2 0 0 0 .18 2.472C4.3 18.241 0 22.679 0 28.133q0 .74.106 1.453a.46.46 0 0 0 .457.402h43.704a.57.57 0 0 0 .54-.418"/></svg>`,
  "/logos/cloudflare-wordmark.svg": `<svg width="120" height="24" viewBox="0 0 120 24" fill="none" xmlns="http://www.w3.org/2000/svg"><text x="0" y="18" font-family="system-ui, -apple-system, sans-serif" font-size="16" font-weight="600" fill="#521000">Cloudflare</text></svg>`,
  "/cf-icons/cloudflare-workers_outline.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" fill="none" viewBox="0 0 64 64"><path fill="#F63" d="m24.841 49.17-12.86-17.2 12.79-16.71-2.47-3.37-14.41 18.85-.02 2.41 14.48 19.39 2.49-3.37Z"/><path fill="#F63" d="M29.331 7.95h-4.95l17.85 24.4-17.43 23.6h4.98l17.42-23.59-17.87-24.41Z"/><path fill="#F63" d="M38.901 7.95h-5.01l18.13 24.11-18.13 23.89h5.02l17.21-22.68v-2.41L38.901 7.95Z"/></svg>`,
  "/cf-icons/cloudflare-durable-objects_outline.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" fill="none" viewBox="0 0 64 64"><path fill="#F63" d="M23.493 19.421a3 3 0 1 0-4.92 3.434 3 3 0 0 0 4.92-3.434Zm21.965 25.986a3 3 0 1 1-3.433-4.92 3 3 0 0 1 3.433 4.92Z"/><path fill="#F63" fill-rule="evenodd" d="M32.214 6h-.202a26 26 0 1 0 .327 52c.177 0 .352-.005.526-.014A26.002 26.002 0 0 0 58.012 32 26 26 0 0 0 32.865 6.014a9.863 9.863 0 0 0-.651-.013Zm-9.504 6.063a21.995 21.995 0 0 0-11.024 11.518A21.998 21.998 0 0 0 10.103 30h7.805c.044-1.192.129-2.364.252-3.51l3.997.24a46.378 46.378 0 0 0-.246 3.27H30V10.519c-1.784.81-3.474 2.582-4.899 5.41-.093.185-.185.374-.275.567l-3.872-1.145c.184-.418.375-.825.575-1.221.362-.72.756-1.412 1.181-2.067ZM30 34h-8.09c.227 5.584 1.393 10.5 3.191 14.071 1.425 2.829 3.115 4.6 4.899 5.41V34Zm-7.29 17.937a21.939 21.939 0 0 1-1.181-2.067c-2.132-4.233-3.394-9.795-3.621-15.87h-7.805A21.999 21.999 0 0 0 22.71 51.937Zm19.555-.472A22 22 0 0 0 53.92 34h-7.15a50.635 50.635 0 0 1-.26 3.589l-3.999-.24c.123-1.084.21-2.202.256-3.349H34v19.742c2.031-.641 3.973-2.486 5.577-5.671.085-.17.169-.342.251-.517l3.874 1.145c-.177.4-.361.791-.553 1.171a22.408 22.408 0 0 1-.884 1.595ZM42.768 30H34V10.258c2.031.641 3.973 2.486 5.577 5.671 1.798 3.572 2.965 8.487 3.19 14.071Zm4.002 0c-.227-6.075-1.489-11.637-3.62-15.87a22.386 22.386 0 0 0-.885-1.595A22 22 0 0 1 53.92 30h-7.15Z" clip-rule="evenodd"/></svg>`,
  "/cf-icons/cloudflare-kv_outline.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" fill="none" viewBox="0 0 64 64"><path fill="#F63" d="M22 44.95h-7v-4h7v4Zm-7-8h7v-4h-7v4Zm7-8h-7v-4h7v4Zm4 16h23v-4H26v4Zm23-8H26v-4h23v4Zm-23-8h23v-4H26v4Z"/><path fill="#F63" fill-rule="evenodd" d="m6 12 2-2h19l1.675.907 3.408 5.225H56l2 2V52l-2 2H8l-2-2V12Zm4 2v36h44V20.132H31l-1.675-.908L25.917 14H10Z" clip-rule="evenodd"/></svg>`,
  "/cf-icons/innovation-intelligence_outline.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" fill="none" viewBox="0 0 64 64"><path fill="#F63" d="M53.69 19.32a11.982 11.982 0 0 0-16.52-8.3 10 10 0 0 0-15.29 1.16A9.91 9.91 0 0 0 20 12a10.017 10.017 0 0 0-10 10c0 .341.02.682.06 1.02A11.988 11.988 0 0 0 18 44a12.201 12.201 0 0 0 4.31-.8A12.08 12.08 0 0 0 30 46c.428-.002.855-.028 1.28-.08.288-.025.575-.065.86-.12a.17.17 0 0 0 .07-.01 9.06 9.06 0 0 0 1.03-.24.075.075 0 0 1 .05-.01c.16-.05.32-.11.48-.16.18-.07.37-.12.55-.19l12.22 12.8 3.45-1.61-1.55-12.93A11.05 11.05 0 0 0 56 33v-.33a9.013 9.013 0 0 0-2.31-13.35Zm.22 8.59a8.076 8.076 0 0 0-5.97-2.64h-3.78v4h3.78a4.124 4.124 0 0 1 3.8 2.52l.08.17c.05.13.11.26.14.36.02.23.04.45.04.68a7.011 7.011 0 0 1-6.03 6.93l-1.95.27 1.28 10.71-7.61-7.98a10.449 10.449 0 0 0 3.11-7.44h-4a6.485 6.485 0 0 1-4.18 6.05 6.61 6.61 0 0 1-.63.2c-.01.01-.02.01-.04.01a6.947 6.947 0 0 1-.93.18c-.01 0-.02.01-.04.01h-.07c-.2.02-.4.03-.6.03v.01c-.1 0-.21.02-.31.02a7.906 7.906 0 0 1-3.99-1.08A11.97 11.97 0 0 0 30 31.99h-4a8.02 8.02 0 0 1-4.24 7.07 7.98 7.98 0 0 1-10.22-11.74 9.863 9.863 0 0 0 4.45 3.83l1.4-3.76a5.901 5.901 0 0 1-3.22-4A6.211 6.211 0 0 1 14 22a5.985 5.985 0 0 1 8.11-5.61l1.71.64.79-1.64a5.97 5.97 0 0 1 9.14-2.06 11.913 11.913 0 0 0-3.75 8.7c0 .636.05 1.272.15 1.9h4.09a7.56 7.56 0 0 1-.24-1.9 8 8 0 0 1 15.92-1.13l.15 1.09 1 .46A5 5 0 0 1 54 27c0 .306-.03.61-.09.91Z"/></svg>`,
  "/cf-icons/server-database_outline.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" fill="none" viewBox="0 0 64 64"><path fill="#F63" d="M25.16 47.46a2.28 2.28 0 1 0 0 4.56 2.28 2.28 0 0 0 0-4.56Zm15.95-37.29H22.88v4h18.23v-4Zm0 7.49H22.88v4h18.23v-4Zm0 7.49H22.88v4h18.23v-4Zm.01 22.59H30.18v4h10.94v-4Z"/><path fill="#F63" d="M48 0H16l-2 2v60l2 2h32l2-2V2l-2-2Zm-2 60H18V4h28v56Z"/></svg>`,
  "/cf-icons/security-shield-protection-1_outline.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" fill="none" viewBox="0 0 64 64"><path fill="#F63" d="M50.41 6H13.59l-2 2v16.88c0 21.55 17.47 31.73 19.46 32.83H33c2-1.1 19.44-11.28 19.44-32.83V8l-2.03-2ZM15.59 24.88V10H30v42.28c-5-3.66-14.41-12.48-14.41-27.4Zm32.82 0c0 14.92-9.36 23.74-14.4 27.4V10h14.4v14.88Z"/></svg>`,
  "/cf-icons/code-brackets_outline.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" fill="none" viewBox="0 0 64 64"><path fill="#F63" d="M22.248 58v-3.981c-4.597 0-6.023-2.153-6.023-6.907v-8.125c0-3.31-1.01-5.768-5.549-6.682v-.61c4.538-.914 5.549-3.372 5.549-6.683v-8.125c0-4.753 1.426-6.906 6.023-6.906V6c-7.767 0-10.303 3.412-10.303 10.887v6.5c0 4.449-1.526 6.175-5.945 6.175v4.875c4.419 0 5.945 1.727 5.945 6.175v6.5C11.945 54.587 14.48 58 22.248 58ZM41.752 6v3.981c4.597 0 6.023 2.153 6.023 6.906v8.125c0 3.311 1.01 5.77 5.549 6.683v.61c-4.538.914-5.549 3.372-5.549 6.682v8.125c0 4.754-1.426 6.907-6.023 6.907V58c7.767 0 10.303-3.413 10.303-10.888v-6.5c0-4.448 1.526-6.175 5.945-6.175v-4.874c-4.419 0-5.945-1.727-5.945-6.175v-6.5C52.055 9.412 49.52 6 41.752 6Z"/></svg>`,
  "/cf-icons/network-scale_outline.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" fill="none" viewBox="0 0 64 64"><path fill="#F63" d="M59.75 13.74a7.79 7.79 0 0 0-15.15-2.53l-25.06-.08a7.78 7.78 0 1 0-9.48 8.24l4.42 26.15a7.78 7.78 0 1 0 11.71 7.65L42 48.58a7.78 7.78 0 1 0 9.29-11.43l2.39-15.83a7.78 7.78 0 0 0 6.07-7.58ZM43.9 38.25l-10.37-5.88a7.87 7.87 0 0 0 .31-2.14 7.742 7.742 0 0 0-.43-2.51l13.26-8.28a7.82 7.82 0 0 0 3 1.75l-2.33 15.57a7.67 7.67 0 0 0-3.44 1.49Zm.62-22.19-13.33 8.33a7.75 7.75 0 0 0-8.25-1.3l-4.86-6.74c.278-.385.522-.793.73-1.22l25.5.08c.06.29.13.57.21.85ZM22.26 30.23a3.79 3.79 0 1 1 7.58-.04 3.79 3.79 0 0 1-7.58.04ZM52 10a3.79 3.79 0 1 1 0 7.581 3.79 3.79 0 0 1 0-7.58ZM8 11.78a3.79 3.79 0 1 1 7.58 0 3.79 3.79 0 0 1-7.58 0Zm6.09 7.44c.305-.092.602-.206.89-.34l4.83 6.71a7.759 7.759 0 0 0 1.86 11.08l-2.58 7.77h-.74l-4.26-25.22ZM18.47 56a3.79 3.79 0 1 1 0-7.58 3.79 3.79 0 0 1 0 7.58Zm7.18-6.81a7.8 7.8 0 0 0-2.79-3.4L25.45 38h.6a7.76 7.76 0 0 0 5.42-2.21l10 5.63a7.867 7.867 0 0 0-.6 3v.32l-15.22 4.45Zm23-.94a3.79 3.79 0 1 1 3.79-3.79 3.79 3.79 0 0 1-3.83 3.77l.04.02Z"/></svg>`,
  "/cf-icons/internet-browser_outline.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" fill="none" viewBox="0 0 64 64"><path fill="#F63" d="M14.49 21.6a2.09 2.09 0 1 0 0-4.18 2.09 2.09 0 0 0 0 4.18Zm6.7 0a2.09 2.09 0 1 0 0-4.18 2.09 2.09 0 0 0 0 4.18Zm6.69 0a2.09 2.09 0 1 0 0-4.18 2.09 2.09 0 0 0 0 4.18Z"/><path fill="#F63" d="M56 12.07H8l-2 2v39.87l2 2h48l2-2V14.07l-2-2Zm-2 4V23H10v-6.93h44ZM10 51.94V27h44v25l-44-.06Z"/></svg>`,
  "/cf-icons/logo-github_regular.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" fill="none" viewBox="0 0 64 64"><path fill="#F63" fill-rule="evenodd" d="M31.989 5.95c-14.356 0-26 11.936-26 26.66a26.613 26.613 0 0 0 17.784 25.295c1.3.244 1.774-.58 1.774-1.285 0-.633-.022-2.31-.035-4.534-7.232 1.61-8.758-3.574-8.758-3.574-1.182-3.08-2.887-3.9-2.887-3.9-2.361-1.654.179-1.621.179-1.621a5.478 5.478 0 0 1 3.982 2.748c2.319 4.073 6.085 2.9 7.567 2.215a5.747 5.747 0 0 1 1.651-3.564c-5.774-.672-11.847-2.96-11.847-13.175a10.448 10.448 0 0 1 2.676-7.153 9.806 9.806 0 0 1 .255-7.055s2.183-.717 7.149 2.733a24.041 24.041 0 0 1 13.019 0c4.963-3.45 7.142-2.733 7.142-2.733a9.8 9.8 0 0 1 .259 7.055 10.433 10.433 0 0 1 2.673 7.153c0 10.24-6.079 12.5-11.871 13.155a6.45 6.45 0 0 1 1.765 4.937c0 3.564-.032 6.439-.032 7.313 0 .713.468 1.542 1.788 1.282A26.618 26.618 0 0 0 57.991 32.61c0-14.725-11.642-26.66-26.002-26.66Z" clip-rule="evenodd"/></svg>`,
  "/cf-icons/warning_outline.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" fill="none" viewBox="0 0 64 64"><path fill="#F63" d="M32 6a26 26 0 1 0 26 26A26.029 26.029 0 0 0 32 6Zm0 48a22 22 0 1 1 22-22 22.025 22.025 0 0 1-22 22Z"/><path fill="#F63" d="M34.077 37.229H29.74L29.127 19h5.564l-.614 18.229Zm-2.168 2.855c.879 0 1.584.258 2.113.776.542.518.813 1.18.813 1.988 0 .795-.27 1.451-.813 1.969-.53.518-1.234.777-2.113.777-.867 0-1.572-.26-2.114-.777-.53-.518-.795-1.174-.795-1.97 0-.794.265-1.45.795-1.969.542-.53 1.246-.794 2.114-.794Z"/></svg>`
};

function isSlideFilename(filename: string) {
  return /^[a-z0-9][a-z0-9-]*\.tsx$/.test(filename);
}

function makeRegistry(slideFiles: string[]) {
  const imports = slideFiles.map((path, index) => {
    const specifier = `./slides/${path
      .split("/")
      .pop()
      ?.replace(/\.tsx$/, "")}`;
    return `import Slide${index} from '${specifier}';`;
  });
  const entries = slideFiles.map((path, index) => {
    const name =
      path
        .split("/")
        .pop()
        ?.replace(/\.tsx$/, "") ?? `slide-${index}`;
    return `  { name: ${JSON.stringify(name)}, Component: Slide${index} }`;
  });
  return [
    "import type { ComponentType } from 'react';",
    ...imports,
    "",
    "export interface SlideEntry {",
    "  name: string;",
    "  Component: ComponentType;",
    "}",
    "",
    "export const slides: SlideEntry[] = [",
    entries.join(",\n"),
    "];",
    ""
  ].join("\n");
}

export class SlideDeckAgent extends Think<Env, SlideDeckState> {
  initialState = INITIAL_STATE;
  generatedApp?: GeneratedApp;
  previewVersion = 0;

  async onStart() {
    this.previewVersion =
      ((await this.ctx.storage.get("previewVersion")) as number | undefined) ??
      0;
    await this.getGeneratedDeckApp().seed();
    const slideFiles = await this.listSlides();
    const sourceFiles = await this.readDisplaySource();
    this.setState({
      built: slideFiles.length > 0,
      previewVersion: this.previewVersion,
      slideCount: slideFiles.length,
      slideFiles,
      sourceFiles,
      updatedAt: Date.now()
    });
  }

  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.6"
    );
  }

  getSystemPrompt() {
    return [
      "You are a slide deck creation agent.",
      "Your workspace is a small React slide deck app backed by durable storage.",
      "Slides live in /src/slides/*.tsx and use helpers from /src/components.tsx, /src/cf2026.tsx, /src/diagrams.tsx, and /src/icons.tsx.",
      "Before writing slides, read /STYLE_GUIDE.md and /REFERENCE_SLIDES.md.",
      "If the user has not specified a style, choose the best fit and mention it briefly: workers.dev for expressive developer/product decks, cf2026 for official/customer/executive decks.",
      "Create focused, presentation-quality slides. Prefer one clear idea per slide.",
      "Use SlideFrame, SlideHeader, Pill, BigTitle, Lead, FeatureCard, Stat, and CodeBlock from ../components instead of hand-rolling page chrome.",
      "Use cf2026 components from ../cf2026 when fidelity to the official Cloudflare presentation template matters.",
      "The cf2026 module includes covers, dividers, content columns, stats, icon rows, lists, grids, sidebars, timelines, chart slots, image/copy layouts, table-of-contents, client lists, quotes, big-copy, and closing slides.",
      "Use diagram and mockup components from ../diagrams for architecture, CLI, browser, and before/after slides.",
      "Use CFIcon from ../icons for branded pictograms; never invent icon names.",
      "Use the prebuilt layout components to vary slide structure: CoverLayout for openers, SplitLayout for visual explanations, FeatureGridLayout for capability groups, StatHeroLayout for proof points, TimelineLayout for sequences, ComparisonLayout for before/after, QuoteLayout for a strong statement, and ProcessFlowLayout for workflows.",
      "Avoid repeating the same title/lead/card-grid format across a deck.",
      "Use saveSlide when creating or replacing a slide. It schedules a debounced preview rebuild. Use buildDeck only when you need an immediate manual rebuild.",
      "Do not use bash or containers. The preview is bundled directly from the workspace with Worker Bundler."
    ].join("\n");
  }

  getTools(): ToolSet {
    return {
      listSlides: tool({
        description: "List slide source files in the deck workspace.",
        inputSchema: z.object({}),
        execute: async () => ({ slides: await this.listSlides() })
      }),
      saveSlide: tool({
        description:
          "Create or replace one React slide in /src/slides and rebuild the preview.",
        inputSchema: z.object({
          filename: z
            .string()
            .describe("Kebab-case TSX filename, e.g. 002-product-story.tsx"),
          code: z
            .string()
            .describe("Complete React component source for the slide")
        }),
        execute: async ({ filename, code }) => this.saveSlide(filename, code)
      }),
      buildDeck: tool({
        description:
          "Bundle the current workspace into a live preview and report diagnostics.",
        inputSchema: z.object({}),
        execute: async () => this.buildDeck()
      })
    };
  }

  @callable()
  async listWorkspaceFiles(path = "/"): Promise<FileInfo[]> {
    return this.workspace.readDir(path);
  }

  @callable()
  async readWorkspaceFile(path: string): Promise<string | null> {
    return this.workspace.readFile(path);
  }

  @callable()
  async saveSlide(filename: string, code: string): Promise<SlideDeckState> {
    if (!isSlideFilename(filename)) {
      throw new Error(
        "Slide filenames must be lowercase kebab-case .tsx files, e.g. 002-launch-plan.tsx"
      );
    }
    await this.workspace.writeFile(`/src/slides/${filename}`, code);
    return this.requestDeckRebuild("saveSlide");
  }

  @callable()
  async buildDeck(): Promise<SlideDeckState> {
    const state = await this.getGeneratedDeckApp().rebuildNow("buildDeck");
    return this.stateFromBuildState(state);
  }

  private async requestDeckRebuild(reason: string): Promise<SlideDeckState> {
    const state = await this.getGeneratedDeckApp().requestRebuild(reason);
    return this.stateFromBuildState(state);
  }

  private async stateFromBuildState(
    buildState: GeneratedAppBuildState
  ): Promise<SlideDeckState> {
    const slideFiles = await this.listSlides().catch(() => []);

    const nextState: SlideDeckState = {
      built: buildState.status === "built",
      previewVersion: buildState.previewVersion,
      slideCount: slideFiles.length,
      slideFiles,
      warnings: buildState.warnings,
      error: buildState.status === "error" ? buildState.error : undefined,
      sourceFiles: await this.readDisplaySource().catch(() => undefined),
      updatedAt: buildState.updatedAt ?? Date.now()
    };
    this.setState(nextState);
    return nextState;
  }

  private getGeneratedDeckApp(): GeneratedApp {
    if (!this.generatedApp) {
      this.generatedApp = createGeneratedApp({
        workspace: this.workspace,
        seed: () => ({ files: this.makeSeedFiles() }),
        source: () =>
          createWorkspaceSourceProvider(this.workspace, {
            sources: ["/package.json", "/src/**"],
            assets: ["/public/**"],
            exclude: ["/src/styles.css"]
          }),
        virtualFiles: async () => ({
          "src/server.ts": GENERATED_APP_SERVER,
          "src/client.tsx": GENERATED_APP_CLIENT,
          "src/registry.ts": makeRegistry(await this.listSlides())
        }),
        virtualAssets: async () => ({
          "/index.html": INDEX_HTML,
          "/styles.css":
            (await this.workspace.readFile("/src/styles.css")) ?? DEFAULT_STYLES
        }),
        build: {
          server: "src/server.ts",
          client: "src/client.tsx",
          assetConfig: {
            not_found_handling: "single-page-application"
          },
          jsx: "automatic"
        },
        preview: {
          loader: this.env.LOADER,
          name: `${this.name}-slide-deck`
        },
        rebuild: {
          debounceMs: 250,
          initialPreviewVersion: this.previewVersion,
          onPreviewVersionChange: async (previewVersion: number) => {
            this.previewVersion = previewVersion;
            await this.ctx.storage.put("previewVersion", previewVersion);
          }
        }
      });
    }
    return this.generatedApp;
  }

  @callable()
  async resetDeck(): Promise<SlideDeckState> {
    const entries = await this.workspace.glob("/**");
    for (const entry of entries) {
      if (entry.type === "file") {
        await this.workspace.rm(entry.path, { force: true });
      }
    }
    this.generatedApp = undefined;
    this.previewVersion = 0;
    await this.ctx.storage.put("previewVersion", 0);
    await this.getGeneratedDeckApp().seed();
    return this.buildDeck();
  }

  async onRequest(request: Request): Promise<Response> {
    try {
      const app = this.getGeneratedDeckApp();
      if (!app.getResult()) {
        const state = await this.buildDeck();
        if (!state.built) {
          throw new Error(state.error ?? "Deck preview is not built");
        }
      }
      return app.serve(request);
    } catch (error) {
      return new Response(
        error instanceof Error ? error.message : "Deck preview is not built",
        { status: 500 }
      );
    }
  }

  private makeSeedFiles(): Record<string, string> {
    const files: Record<string, string> = {
      "/package.json": GENERATED_APP_PACKAGE_JSON,
      "/STYLE_GUIDE.md": STYLE_GUIDE,
      "/REFERENCE_SLIDES.md": REFERENCE_SLIDES,
      "/src/components.tsx": DEFAULT_COMPONENTS,
      "/src/cf2026.tsx": CF2026_COMPONENTS,
      "/src/icons.tsx": ICON_COMPONENTS,
      "/src/diagrams.tsx": DIAGRAM_COMPONENTS,
      "/src/styles.css": DEFAULT_STYLES,
      "/src/slides/001-title.tsx": DEFAULT_SLIDE,
      "/src/slides/002-architecture.tsx": DEFAULT_SLIDE_TWO,
      "/src/slides/003-replacement-goals.tsx": DEFAULT_SLIDE_THREE,
      "/src/slides/004-ported-surface.tsx": DEFAULT_SLIDE_FOUR
    };
    for (const [path, content] of Object.entries(PREVIEW_ASSETS)) {
      files[`/public${path}`] = content;
    }
    return files;
  }

  private async listSlides(): Promise<string[]> {
    const entries = await this.workspace.glob("/src/slides/*.tsx");
    return entries
      .filter((entry) => entry.type === "file")
      .map((entry) => entry.path)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  private async readDisplaySource(): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    const interesting = [
      "/STYLE_GUIDE.md",
      "/REFERENCE_SLIDES.md",
      "/src/components.tsx",
      "/src/cf2026.tsx",
      "/src/icons.tsx",
      "/src/diagrams.tsx",
      "/src/styles.css",
      ...(await this.listSlides())
    ];
    for (const path of interesting) {
      const content = await this.workspace.readFile(path);
      if (content !== null) files[path] = content;
    }
    return files;
  }
}

const previewAssetConfig: AssetConfig = {
  not_found_handling: "single-page-application"
};

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/preview\/([^/]+)(\/.*)?$/);
    if (match) {
      const agentName = decodeURIComponent(match[1]);
      const previewPath = match[2] || "/";
      const id = env.SlideDeckAgent.idFromName(agentName);
      const stub = env.SlideDeckAgent.get(id);
      const proxyUrl = new URL(previewPath, request.url);
      const response = await stub.fetch(new Request(proxyUrl, request));
      if (
        response.status === 404 &&
        previewAssetConfig.not_found_handling === "single-page-application"
      ) {
        const fallbackUrl = new URL("/", request.url);
        return stub.fetch(new Request(fallbackUrl, request));
      }
      return response;
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
