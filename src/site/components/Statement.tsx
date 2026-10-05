import { ScrollProgress } from "@/site/components/ScrollProgress";

/**
 * A large editorial statement whose words fill in from muted to ink as it
 * scrolls through the middle of the screen. Words wrapped in *asterisks* are
 * set in the accent colour. Without motion (or without JS) it is simply
 * printed in full.
 */
export function Statement({ text, id, className = "" }: { text: string; id?: string; className?: string }) {
  const words = text.split(/\s+/);
  return (
    <ScrollProgress start={0.85} end={0.55} className={`s-statement ${className}`} style={{ "--n": words.length } as React.CSSProperties}>
      <p id={id}>
        {words.map((w, i) => {
          const accent = w.startsWith("*");
          const clean = w.replace(/\*/g, "");
          return (
            <span key={i} className={accent ? "s-statement-accent" : undefined} style={{ "--i": i } as React.CSSProperties}>
              {clean}{" "}
            </span>
          );
        })}
      </p>
    </ScrollProgress>
  );
}
