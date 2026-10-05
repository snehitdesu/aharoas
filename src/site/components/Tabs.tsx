"use client";

import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

/**
 * Accessible tab list (WAI-ARIA tabs pattern: roving tabindex, arrow keys,
 * Home / End). Panels are rendered by the caller with `panelProps(i)`.
 */
export function useTabs(count: number, active: number, setActive: (i: number) => void) {
  const base = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const keys: Record<string, number> = { ArrowRight: active + 1, ArrowLeft: active - 1, Home: 0, End: count - 1 };
    if (!(e.key in keys)) return;
    e.preventDefault();
    const next = (keys[e.key] + count) % count;
    setActive(next);
    refs.current[next]?.focus();
  };
  return {
    tabProps: (i: number) => ({
      ref: (el: HTMLButtonElement | null) => {
        refs.current[i] = el;
      },
      id: `${base}-tab-${i}`,
      role: "tab" as const,
      type: "button" as const,
      "aria-selected": active === i,
      "aria-controls": `${base}-panel-${i}`,
      tabIndex: active === i ? 0 : -1,
      onClick: () => setActive(i),
      onKeyDown,
      className: "s-tab",
    }),
    panelProps: (i: number) => ({
      id: `${base}-panel-${i}`,
      role: "tabpanel" as const,
      "aria-labelledby": `${base}-tab-${i}`,
      hidden: active !== i,
      tabIndex: 0,
    }),
  };
}

export function TabList({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div role="tablist" aria-label={label} className={`s-tabs ${className}`}>
      {children}
    </div>
  );
}
