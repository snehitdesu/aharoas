import type { ReactNode } from "react";

/** Long-form page layout: resources, release notes, security, legal. */
export function ProsePage({ eyebrow, title, intro, draft, children }: { eyebrow: string; title: string; intro?: ReactNode; draft?: boolean; children: ReactNode }) {
  return (
    <article className="pb-[var(--s-section)] pt-14 sm:pt-20">
      <header className="s-wrap-narrow">
        <p className="s-eyebrow">{eyebrow}</p>
        <h1 className="s-h2 mt-4 !text-[clamp(2.5rem,6vw,4.5rem)]">{title}</h1>
        {intro && <p className="s-lead mt-6">{intro}</p>}
        {draft && (
          <p className="s-draft mt-8" role="note">
            <strong>Draft for review.</strong> This document has not been reviewed by a lawyer and does not yet name the legal entity that operates RESTORA. It describes how the software handles data today. It must be completed and approved before RESTORA is offered to customers.
          </p>
        )}
      </header>
      <div className="s-wrap-narrow s-prose mt-10">{children}</div>
    </article>
  );
}
