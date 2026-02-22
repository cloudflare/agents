import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Text } from "@cloudflare/kumo";
import { ArrowLeftIcon } from "@phosphor-icons/react";

interface DemoWrapperProps {
  title: string;
  description: ReactNode;
  statusIndicator?: ReactNode;
  children: ReactNode;
}

export function DemoWrapper({
  title,
  description,
  statusIndicator,
  children
}: DemoWrapperProps) {
  return (
    <div className="h-full flex flex-col">
      <div className="px-4 md:px-6 pt-3">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-sm text-kumo-subtle hover:text-kumo-default transition-colors"
        >
          <ArrowLeftIcon size={14} />
          All demos
        </Link>
      </div>
      <header className="flex items-start justify-between gap-4 px-4 md:px-6 pb-3 pt-2 border-b border-kumo-line">
        <div className="min-w-0">
          <Text variant="heading2">{title}</Text>
        </div>
        {statusIndicator && <div className="shrink-0">{statusIndicator}</div>}
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto p-4 md:p-6">
        <div className="mb-6 max-w-2xl [&_*]:!leading-6">
          <Text variant="secondary" size="sm">
            {description}
          </Text>
        </div>
        {children}
      </div>
    </div>
  );
}
