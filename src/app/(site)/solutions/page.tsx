import type { Metadata } from "next";
import Link from "next/link";
import { MoreLink } from "@/site/components/Section";
import { SOLUTIONS, moduleBySlug } from "@/site/content";

export const metadata: Metadata = {
  title: "Solutions",
  description: "How full-service restaurants, cafés, quick service, delivery kitchens, prep kitchens and multi-outlet restaurant businesses use RESTORA.",
  alternates: { canonical: "/solutions" },
};

export default function SolutionsPage() {
  return (
    <>
      <section aria-labelledby="solutions-title" className="pb-10 pt-14 sm:pt-20">
        <div className="s-wrap">
          <p className="s-eyebrow">Solutions</p>
          <h1 id="solutions-title" className="s-display mt-5 max-w-[13ch]">
            Built for how your restaurant works.
          </h1>
          <p className="s-lead mt-8 max-w-2xl">RESTORA is one system. Different restaurants lean on different parts of it. Here is what each kind uses today, and where the limits are.</p>
        </div>
      </section>

      <section aria-label="Restaurant types" className="s-section pt-10">
        <div className="s-wrap">
          <ol className="grid">
            {SOLUTIONS.map((s, i) => (
              <li key={s.name} className="s-reveal grid gap-8 border-t border-[color:var(--s-rule-strong)] py-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
                <div>
                  <p className="s-num text-sm font-semibold text-[color:var(--s-accent-ink)]">{String(i + 1).padStart(2, "0")}</p>
                  <h2 className="s-h3 mt-2">{s.name}</h2>
                  <p className="s-body mt-4 text-[1.0625rem]">{s.body}</p>
                </div>
                <div className="grid gap-8 sm:grid-cols-2">
                  <div>
                    <h3 className="s-h4">What they use</h3>
                    <ul className="s-ticks mt-4">
                      {s.uses.map((u) => (
                        <li key={u}>{u}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h3 className="s-h4">Modules</h3>
                    <ul className="mt-4 grid gap-2">
                      {s.modules.map((slug) => (
                        <li key={slug}>
                          <Link href={`/product/${slug}`} className="s-link">
                            {moduleBySlug(slug)!.name} <span className="s-arrow" aria-hidden>→</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                    {s.limit && <p className="s-small mt-6">{s.limit}</p>}
                  </div>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-[color:var(--s-rule-strong)] pt-12">
            <Link href="/download" className="s-btn s-btn-primary">
              Download RESTORA
            </Link>
            <MoreLink href="/#demo">Try the demonstration</MoreLink>
          </div>
        </div>
      </section>
    </>
  );
}
