"use client";

import { useEffect, useRef, useState } from "react";
import { Screen } from "@/site/components/Screen";
import type { ScreenName } from "@/site/screens";

export type FlowStep = { key: string; label: string; title: string; body: string; screen: ScreenName };

/**
 * The one scroll-driven story on the homepage. Large screens: the steps scroll
 * past a sticky product frame that switches to each step's real screen.
 * Small screens / reduced motion: a plain sequence, each step with its screen.
 * No scroll hijacking, no pinning library: CSS `position: sticky` plus an
 * IntersectionObserver that only decides which step is current.
 */
export function FlowStory({ steps }: { steps: FlowStep[] }) {
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLLIElement | null)[]>([]);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.index));
        }
      },
      { rootMargin: "-45% 0px -45% 0px", threshold: 0 },
    );
    refs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
      <ol className="relative" aria-label="How an order moves through RESTORA">
        {steps.map((s, i) => (
          <li
            key={s.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            data-index={i}
            className="flex flex-col justify-center border-t border-[color:var(--s-rule)] py-10 lg:min-h-[72vh] lg:border-t-0 lg:py-0"
          >
            <div className="relative lg:max-w-md lg:pl-7">
              <span
                aria-hidden
                className={`absolute bottom-1 left-0 top-1 hidden w-[3px] rounded-full transition-colors duration-500 lg:block ${active === i ? "bg-[color:var(--s-accent)]" : "bg-[color:var(--s-rule)]"}`}
              />
              <p className="s-eyebrow s-num">
                {String(i + 1).padStart(2, "0")} · {s.label}
              </p>
              <h3 className="s-h3 mt-3">{s.title}</h3>
              <p className="s-body mt-4 text-[1.0625rem]">{s.body}</p>
            </div>
            <div className="mt-8 lg:hidden">
              <StepScreen name={s.screen} />
            </div>
          </li>
        ))}
      </ol>

      <div className="hidden lg:block">
        <div className="sticky top-[calc(50vh-17rem)]">
          <div className="relative h-[34rem]">
            {steps.map((s, i) => (
              <div
                key={s.key}
                aria-hidden={active !== i}
                className={`absolute inset-0 flex items-center justify-center transition-[opacity,transform] duration-700 ${active === i ? "opacity-100" : "pointer-events-none translate-y-3 opacity-0"}`}
                style={{ transitionTimingFunction: "var(--s-ease)" }}
              >
                <StepScreen name={s.screen} />
              </div>
            ))}
          </div>
          <ol className="mt-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" aria-hidden>
            {steps.map((s, i) => (
              <li key={s.key} className="flex items-center gap-2">
                <span className={active === i ? "font-semibold text-[color:var(--s-ink)]" : "text-[color:var(--s-muted)]"}>{s.label}</span>
                {i < steps.length - 1 && <span className="text-[color:var(--s-muted)]">→</span>}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

function StepScreen({ name }: { name: ScreenName }) {
  const phone = name === "guest-cart" || name === "guest-menu" || name === "captain" || name === "manager";
  return phone ? (
    <Screen name={name} className="mx-auto w-[min(17rem,70%)]" sizes="(min-width: 1024px) 272px, 70vw" />
  ) : (
    <Screen name={name} className="w-full" sizes="(min-width: 1280px) 720px, (min-width: 1024px) 58vw, 100vw" />
  );
}
