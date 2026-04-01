import { useCallback, useRef } from "react";

export function ResizeHandle({
  onResize
}: {
  onResize: (delta: number) => void;
}) {
  const startX = useRef<number | null>(null);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startX.current = e.clientX;

      const onMouseMove = (ev: MouseEvent) => {
        if (startX.current === null) return;
        onResize(ev.clientX - startX.current);
        startX.current = ev.clientX;
      };

      const onMouseUp = () => {
        startX.current = null;
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [onResize]
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onMouseDown={onMouseDown}
      className="w-1 shrink-0 bg-kumo-line hover:bg-kumo-accent cursor-col-resize transition-colors"
    />
  );
}
