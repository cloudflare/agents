import type { ReactNode } from "react";
import { Text } from "@cloudflare/kumo";

interface DemoWrapperProps {
  title: string;
  description: string;
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
      <header className="flex items-start justify-between gap-4 p-4 md:p-6 border-b border-kumo-line">
        <div className="min-w-0">
          <Text variant="heading2">{title}</Text>
          <div className="mt-1">
            <Text variant="secondary" size="sm">
              {description}
            </Text>
          </div>
        </div>
        {statusIndicator && <div className="shrink-0">{statusIndicator}</div>}
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto p-4 md:p-6">
        {children}
      </div>
    </div>
  );
}
