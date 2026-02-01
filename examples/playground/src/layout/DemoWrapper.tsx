import type { ReactNode } from "react";

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
      <header className="p-6 border-b border-neutral-200 dark:border-neutral-700">
        <h1 className="text-2xl font-bold">{title}</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
          {description}
        </p>
      </header>
      <div className="flex-1 overflow-y-auto p-6">{children}</div>
    </div>
  );
}
