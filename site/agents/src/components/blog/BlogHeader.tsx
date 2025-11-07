import { Logo } from "../logo";
import { AGENTS_DOCS_HREF, DASHBOARD_HREF } from "../links";

export function BlogHeader() {
  return (
    <nav className="sticky top-0 z-30 bg-white border-b border-orange-400">
      <div className="max-w-[1400px] mx-auto px-6 py-4 flex items-center justify-between">
        <a
          href="/"
          className="flex items-center gap-3 text-orange-400 hover:text-orange-500 transition-colors"
        >
          <Logo size={40} />
          <span className="font-semibold text-lg">Cloudflare Agents</span>
        </a>

        <div className="flex items-center gap-6">
          <a
            href="/"
            className="text-orange-600 hover:text-orange-700 hover:underline underline-offset-2 transition-colors"
          >
            Home
          </a>
          <a
            href="/blog"
            className="text-orange-600 hover:text-orange-700 hover:underline underline-offset-2 transition-colors font-semibold"
          >
            Blog
          </a>
          <a
            href="/authors"
            className="text-orange-600 hover:text-orange-700 hover:underline underline-offset-2 transition-colors"
          >
            Authors
          </a>
          <a
            href={AGENTS_DOCS_HREF}
            target="_blank"
            className="text-orange-600 hover:text-orange-700 hover:underline underline-offset-2 transition-colors"
          >
            Docs ↗
          </a>
          <a
            href={DASHBOARD_HREF}
            target="_blank"
            className="bg-orange-400 text-white px-4 py-2 rounded-full hover:bg-orange-500 transition-colors font-semibold"
          >
            Get Started
          </a>
        </div>
      </div>
    </nav>
  );
}
