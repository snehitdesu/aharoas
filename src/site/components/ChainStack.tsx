"use client";

import { useRef, type ReactNode } from "react";
import { clamp01, useScrollFrame } from "@/site/motion";

export type ChainCard = {
  key: string;
  label: string;
  title: string;
  body: string;
  media: ReactNode;
  tone?: "paper" | "sand" | "espresso";
};

/**
 * The signature interaction: one order, followed card by card.
 *
 * Desktop (≥1024 × 640): every card is `position: sticky` with a top offset one
 * tab lower than the card before, so arriving cards slide over the previous
 * ones and leave their header tab showing, like index cards filed in a box.
 * The only script reads where each card is and writes two variables: `--e`
 * (how far the card has arrived) and `--d` (how many cards now lie on top of
 * it), which CSS turns into a small scale and a dimming veil.
 *
 * Smaller screens, short windows and reduced motion: the same cards in a plain
 * sequence. Every card is real content in reading order either way.
 */
export function ChainStack({ cards, label }: { cards: ChainCard[]; label: string }) {
  const ref = useRef<HTMLOListElement>(null);
  const sticks = useRef<{ vh: number; tops: number[] }>({ vh: 0, tops: [] });
  const n = cards.length;

  useScrollFrame(
    ref,
    (list, active) => {
      const items = Array.from(list.children) as HTMLElement[];
      if (!active) {
        sticks.current = { vh: 0, tops: [] };
        for (const it of items) {
          it.style.removeProperty("--e");
          it.style.removeProperty("--d");
        }
        return;
      }
      const vh = window.innerHeight;
      // Sticky offsets only change with the viewport size, so read them once per size.
      if (sticks.current.vh !== vh || sticks.current.tops.length !== n) {
        sticks.current = { vh, tops: items.map((it) => parseFloat(getComputedStyle(it).top) || 0) };
      }
      const tops = sticks.current.tops;
      // Read every position first, then write (custom properties only drive transforms).
      const enter = items.map((it, i) => clamp01((vh - it.getBoundingClientRect().top) / Math.max(1, vh - tops[i])));
      let depth = 0;
      for (let i = n - 1; i >= 0; i--) {
        items[i].style.setProperty("--e", enter[i].toFixed(4));
        items[i].style.setProperty("--d", Math.min(depth, 3).toFixed(4));
        depth += enter[i] >= 1 ? 1 : enter[i] > 0.35 ? (enter[i] - 0.35) / 0.65 : 0;
      }
    },
    { minWidth: 1024, minHeight: 640 },
  );

  return (
    <ol ref={ref} className="s-stack" aria-label={label} style={{ "--n": n } as React.CSSProperties}>
      {cards.map((c, i) => (
        <li key={c.key} className="s-stack-item" style={{ "--i": i } as React.CSSProperties}>
          <article className="s-card" data-tone={c.tone ?? "paper"} aria-labelledby={`chain-${c.key}`}>
            <header className="s-card-tab">
              <span className="s-num">
                {String(i + 1).padStart(2, "0")}
                <span className="s-card-tab-of"> / {String(n).padStart(2, "0")}</span>
              </span>
              <span className="s-card-tab-label">{c.label}</span>
              <span className="s-card-pips" aria-hidden>
                {cards.map((_, j) => (
                  <i key={j} data-on={j <= i || undefined} />
                ))}
              </span>
            </header>
            <div className="s-card-body">
              <div className="s-card-copy">
                <h3 id={`chain-${c.key}`} className="s-card-title">
                  {c.title}
                </h3>
                <p className="s-card-text">{c.body}</p>
                {i < n - 1 && (
                  <p className="s-card-next">
                    <span>Then</span> {cards[i + 1].label}
                    <span aria-hidden> ↓</span>
                  </p>
                )}
              </div>
              <div className="s-card-media">{c.media}</div>
            </div>
          </article>
        </li>
      ))}
    </ol>
  );
}
