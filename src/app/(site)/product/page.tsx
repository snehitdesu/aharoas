import type { Metadata } from "next";
import Link from "next/link";
import { Screen } from "@/site/components/Screen";
import { MoreLink } from "@/site/components/Section";
import { MODULES } from "@/site/content";

export const metadata: Metadata = {
  title: "Product",
  description: "The RESTORA restaurant operating system: POS, QR ordering, kitchen display, inventory, procurement, finance, analytics, staff roles and integrations.",
  alternates: { canonical: "/product" },
};

export default function ProductIndex() {
  return (
    <>
      <section aria-labelledby="product-title" className="pb-16 pt-14 sm:pt-20">
        <div className="s-wrap">
          <p className="s-eyebrow">Product</p>
          <h1 id="product-title" className="s-display mt-5 max-w-[14ch]">
            Everything the restaurant runs on.
          </h1>
          <p className="s-lead mt-8 max-w-2xl">Nine parts of one system. Each is useful on its own; together, an order placed at a table reaches the kitchen, the bill, the stock and the books without being typed twice.</p>
        </div>
        <div className="s-wrap mt-14">
          <Screen name="dashboard" priority className="w-full" sizes="(min-width: 1280px) 1216px, 100vw" />
          <p className="s-caption">The owner dashboard for one outlet, with sample data.</p>
        </div>
      </section>

      <section aria-labelledby="modules-title" className="s-section pt-8">
        <div className="s-wrap">
          <h2 id="modules-title" className="sr-only">
            Modules
          </h2>
          <ul className="grid">
            {MODULES.map((m, i) => (
              <li key={m.slug} className="s-reveal border-t border-[color:var(--s-rule-strong)]">
                <Link href={`/product/${m.slug}`} className="group grid items-baseline gap-2 py-8 no-underline md:grid-cols-[4rem_minmax(0,5fr)_minmax(0,6fr)_2rem] md:gap-8">
                  <span className="s-num text-sm font-semibold text-[color:var(--s-accent-ink)]">{String(i + 1).padStart(2, "0")}</span>
                  <span className="font-display text-3xl font-semibold leading-tight text-[color:var(--s-ink)] sm:text-4xl">{m.name}</span>
                  <span className="s-body text-[1.0625rem]">
                    <span className="block font-semibold text-[color:var(--s-ink)]">{m.headline}</span>
                    <span className="block text-[color:var(--s-muted)]">{m.summary}</span>
                  </span>
                  <span className="s-accent hidden text-2xl transition-transform group-hover:translate-x-1 md:block" aria-hidden>
                    →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-12">
            <MoreLink href="/#demo">Try the interactive demonstration</MoreLink>
          </p>
        </div>
      </section>
    </>
  );
}
