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
      <header className="flex items-start justify-between gap-4 p-6 border-b border-kumo-line">
        <div>
          <Text variant="heading2">{title}</Text>
          <div className="mt-1">
            <Text variant="secondary" size="sm">
              {description}
            </Text>
          </div>
        </div>
        {statusIndicator}
      </header>
      <div className="flex-1 overflow-y-auto p-6">{children}</div>
    </div>
  );
}
