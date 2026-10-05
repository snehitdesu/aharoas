"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

/**
 * Turns on section reveals once JavaScript runs: marks <html> with `s-js` and
 * adds `is-in` to `.s-reveal` elements as they enter the viewport. Without JS,
 * or with reduced motion, everything is simply visible (see site.css).
 */
export function RevealController() {
  const pathname = usePathname();
  useEffect(() => {
    const root = document.documentElement;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const els = Array.from(document.querySelectorAll<HTMLElement>(".s-reveal"));
    if (reduce || !("IntersectionObserver" in window)) {
      els.forEach((el) => el.classList.add("is-in"));
      return;
    }
    // Anything already on screen is shown immediately (no flash on load).
    els.forEach((el) => {
      if (el.getBoundingClientRect().top < window.innerHeight * 0.95) el.classList.add("is-in");
    });
    root.classList.add("s-js");
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("is-in");
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    els.forEach((el) => !el.classList.contains("is-in") && io.observe(el));
    return () => io.disconnect();
  }, [pathname]);
  return null;
}
