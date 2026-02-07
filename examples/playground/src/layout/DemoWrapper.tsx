import type { ReactNode } from "react";
import { Text } from "@cloudflare/kumo";

interface DemoWrapperProps {
  title: string;
  description: string;
  children: ReactNode;
}

export function DemoWrapper({
  title,
  description,
  children
}: DemoWrapperProps) {
  return (
    <div className="h-full flex flex-col">
      <header className="p-6 border-b border-kumo-line">
        <Text variant="heading2">{title}</Text>
        <Text variant="secondary" size="sm" className="mt-1">
          {description}
        </Text>
      </header>
      <div className="flex-1 overflow-y-auto p-6">{children}</div>
    </div>
  );
}
