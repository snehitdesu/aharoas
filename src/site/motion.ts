"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * Scroll-linked motion for the public website, kept deliberately small:
 *
 * - The browser keeps full control of scrolling. Nothing is pinned by script,
 *   snapped or eased against the wheel; sticky layouts are plain CSS.
 * - `onFrame` runs at most once per animation frame, only while the element is
 *   near the viewport, and only writes CSS custom properties that drive
 *   `transform` / `opacity` (no layout work).
 * - It is off for `prefers-reduced-motion: reduce` and below `minWidth`; then
 *   `onFrame(el, false)` runs once so the component can clear its variables and
 *   the static layout shows.
 */
export function useScrollFrame<T extends HTMLElement>(
  ref: RefObject<T | null>,
  onFrame: (el: T, active: boolean) => void,
  { minWidth = 0, minHeight = 0 }: { minWidth?: number; minHeight?: number } = {},
) {
  const cb = useRef(onFrame);
  cb.current = onFrame;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const size = window.matchMedia(`(min-width: ${minWidth}px) and (min-height: ${minHeight}px)`);
    let raf = 0;
    let visible = false;
    let enabled = false;

    const frame = () => {
      raf = 0;
      if (enabled) cb.current(el, true);
    };
    const schedule = () => {
      if (!raf && visible && enabled) raf = requestAnimationFrame(frame);
    };
    const configure = () => {
      const next = !reduce.matches && size.matches;
      if (next === enabled) return schedule();
      enabled = next;
      el.toggleAttribute("data-motion", enabled);
      if (!enabled) cb.current(el, false);
      schedule();
    };

    const io = new IntersectionObserver(
      ([e]) => {
        visible = e.isIntersecting;
        schedule();
      },
      { rootMargin: "25% 0px 25% 0px" },
    );
    io.observe(el);
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    reduce.addEventListener("change", configure);
    size.addEventListener("change", configure);
    configure();

    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      reduce.removeEventListener("change", configure);
      size.removeEventListener("change", configure);
    };
  }, [ref, minWidth, minHeight]);
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
