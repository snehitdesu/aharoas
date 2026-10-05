import Link from "next/link";
import type { ReactNode } from "react";

/** Eyebrow + headline + lead, the opening of every section. */
export function SectionIntro({
  id,
  eyebrow,
  title,
  lead,
  align = "left",
  as: H = "h2",
  className = "",
  compact = false,
}: {
  id: string;
  eyebrow?: string;
  title: ReactNode;
  lead?: ReactNode;
  align?: "left" | "center" | "split";
  as?: "h1" | "h2";
  className?: string;
  /** Smaller headline for half-width columns. */
  compact?: boolean;
}) {
  const heading = (
    <>
      {eyebrow && <p className="s-eyebrow">{eyebrow}</p>}
      <H id={id} className={`${H === "h1" ? "s-display" : "s-h2"} ${compact ? "s-h2-md" : ""} ${eyebrow ? "mt-4" : ""}`}>
        {title}
      </H>
    </>
  );
  if (align === "split") {
    return (
      <div className={`s-reveal grid gap-6 lg:grid-cols-2 lg:items-end lg:gap-16 ${className}`}>
        <div>{heading}</div>
        {lead && <p className="s-lead lg:pb-2">{lead}</p>}
      </div>
    );
  }
  return (
    <div className={`s-reveal ${align === "center" ? "mx-auto max-w-4xl text-center" : "max-w-3xl"} ${className}`}>
      {heading}
      {lead && <p className={`s-lead mt-6 ${align === "center" ? "mx-auto max-w-2xl" : "max-w-2xl"}`}>{lead}</p>}
    </div>
  );
}

export function MoreLink({ href, children, className = "" }: { href: string; children: ReactNode; className?: string }) {
  return (
    <Link href={href} className={`s-link text-lg ${className}`}>
      {children} <span className="s-arrow" aria-hidden>→</span>
    </Link>
  );
}
