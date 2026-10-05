import type { Metadata } from "next";
import Link from "next/link";
import { MODULES } from "@/site/content";
import { release } from "@/site/release";

export const metadata: Metadata = {
  title: "Resources",
  description: "RESTORA release notes, system requirements, security overview, product guides and legal documents.",
  alternates: { canonical: "/resources" },
};

export default function ResourcesPage() {
  const groups: { title: string; items: [string, string, string][] }[] = [
    {
      title: "Get started",
      items: [
        ["/download", "Download", "Windows desktop app and RESTORA Web."],
        ["/download#requirements", "System requirements", "What each platform needs."],
        ["/#demo", "Interactive demonstration", "Try the flow from table to numbers in your browser."],
      ],
    },
    {
      title: "Releases",
      items: [[`/resources/release-notes`, `Release notes ${release.version}`, "What is included, what changed and the known limits."]],
    },
    {
      title: "Trust",
      items: [
        ["/security", "Security", "Controls in place and known gaps."],
        ["/privacy", "Privacy Policy", "Draft for review."],
        ["/terms", "Terms of Service", "Draft for review."],
      ],
    },
  ];

  return (
    <section aria-labelledby="res-title" className="pb-[var(--s-section)] pt-14 sm:pt-20">
      <div className="s-wrap">
        <p className="s-eyebrow">Resources</p>
        <h1 id="res-title" className="s-display mt-5">
          Resources<span className="s-accent">.</span>
        </h1>
        <p className="s-lead mt-8 max-w-2xl">Everything published about RESTORA so far. Help articles and video guides are not written yet.</p>

        <div className="mt-16 grid gap-14 lg:grid-cols-3">
          {groups.map((g) => (
            <div key={g.title}>
              <h2 className="s-h3">{g.title}</h2>
              <ul className="mt-6">
                {g.items.map(([href, t, d]) => (
                  <li key={href} className="border-t border-[color:var(--s-rule-strong)]">
                    <Link href={href} className="group block py-5 no-underline">
                      <span className="flex items-center justify-between text-lg font-semibold text-[color:var(--s-ink)]">
                        {t} <span className="s-accent transition-transform group-hover:translate-x-1" aria-hidden>→</span>
                      </span>
                      <span className="s-small mt-1 block">{d}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <h2 className="s-h3 mt-20">Product guides</h2>
        <ul className="mt-6 grid gap-x-10 sm:grid-cols-2 lg:grid-cols-3">
          {MODULES.map((m) => (
            <li key={m.slug} className="border-t border-[color:var(--s-rule-strong)]">
              <Link href={`/product/${m.slug}`} className="group block py-5 no-underline">
                <span className="flex items-center justify-between text-lg font-semibold text-[color:var(--s-ink)]">
                  {m.name} <span className="s-accent transition-transform group-hover:translate-x-1" aria-hidden>→</span>
                </span>
                <span className="s-small mt-1 block">{m.summary}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
