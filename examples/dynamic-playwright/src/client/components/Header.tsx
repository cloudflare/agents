import { Badge } from "@cloudflare/kumo";
import { BrowserIcon } from "@phosphor-icons/react";
import { ModeToggle } from "./ModeToggle";

export function Header() {
  return (
    <header className="border-b border-kumo-line bg-kumo-base px-5 py-4">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Dynamic Puppeteer</h1>
          <Badge variant="secondary">
            <BrowserIcon size={12} weight="bold" className="mr-1" />
            Sessions
          </Badge>
        </div>
        <ModeToggle />
      </div>
    </header>
  );
}
