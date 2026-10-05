"use client";

import { useRef, type CSSProperties, type ReactNode } from "react";
import { clamp01, useScrollFrame } from "@/site/motion";

/**
 * Exposes how far an element has travelled through the viewport as `--p`
 * (0 → 1) for CSS to use in transforms and opacity.
 *
 * `--p` is 0 when the element's top reaches `start` (fraction of the viewport
 * height from the top) and 1 when its bottom reaches `end`. When motion is off
 * the variable is removed, so CSS falls back to its static value.
 */
export function ScrollProgress({
  children,
  className = "",
  style,
  start = 1,
  end = 0,
  minWidth = 0,
  as: Tag = "div",
  ...rest
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  start?: number;
  end?: number;
  minWidth?: number;
  as?: "div" | "section";
} & React.AriaAttributes & { id?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useScrollFrame(
    ref,
    (el, active) => {
      if (!active) return el.style.removeProperty("--p");
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      const p = clamp01((start * vh - r.top) / (start * vh - end * vh + r.height));
      el.style.setProperty("--p", p.toFixed(4));
    },
    { minWidth },
  );
  return (
    <Tag ref={ref} className={className} style={style} {...rest}>
      {children}
    </Tag>
  );
}
