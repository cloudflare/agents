import { useId } from "react";

export function BackgroundDots({
  size = 12,
  ...props
}: React.ComponentPropsWithoutRef<"pattern"> & {
  size?: number;
}) {
  const id = useId();
  return (
    <svg width="100%" height="100%">
      <defs>
        <pattern
          id={id}
          viewBox={`-${size / 2} -${size / 2} ${size} ${size}`}
          patternUnits="userSpaceOnUse"
          width={size}
          height={size}
          {...props}
        >
          <circle cx="0" cy="0" r="1" fill="currentColor" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}

export function BackgroundLinesOnly({ size = 64 }) {
  return (
    <div className="flex flex-col justify-between pointer-events-none h-full">
      <div className="flex justify-between">
        <div
          style={{
            width: size,
            height: size
          }}
          className="border-t border-l border-orange-400"
        />
        <div
          style={{
            width: size,
            height: size
          }}
          className="border-t border-r border-orange-400"
        />
      </div>
      <div className="flex justify-between">
        <div
          style={{
            width: size,
            height: size
          }}
          className="border-b border-l border-orange-400"
        />
        <div
          style={{
            width: size,
            height: size
          }}
          className="border-b border-r border-orange-400"
        />
      </div>
    </div>
  );
}

export function BackgroundLines() {
  return (
    <div className="absolute inset-6">
      <BackgroundLinesOnly />
    </div>
  );
}
