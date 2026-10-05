import Link from "next/link";
import { RestoraLogo } from "@/site/components/Logo";
import { FOOTER, SITE_TAGLINE } from "@/site/config";
import { release } from "@/site/release";

export function SiteFooter() {
  return (
    <footer className="s-dark">
      <div className="s-wrap pb-10 pt-20">
        <div className="grid gap-12 lg:grid-cols-[1.2fr_2fr]">
          <div>
            <Link href="/" className="inline-flex no-underline" aria-label="RESTORA home">
              <RestoraLogo tone="ivory" size="lg" />
            </Link>
            <p className="mt-4 max-w-xs font-display text-2xl leading-tight text-[color:var(--s-on-dark)]">{SITE_TAGLINE}.</p>
          </div>
          <div className="grid grid-cols-2 gap-10 sm:grid-cols-4">
            {FOOTER.map((col) => (
              <div key={col.title}>
                <h2 className="text-sm font-semibold text-[color:var(--s-on-dark)]" style={{ fontFamily: "var(--s-font-body)", letterSpacing: 0 }}>
                  {col.title}
                </h2>
                <ul className="mt-4 grid gap-2.5">
                  {col.links.map((l) => (
                    <li key={l.href}>
                      <Link href={l.href} className="text-[0.9375rem] text-[color:var(--s-on-dark-muted)] no-underline hover:text-[color:var(--s-on-dark)]">
                        {l.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-16 flex flex-col gap-3 border-t border-[rgb(247_241_230_/_0.14)] pt-6 text-sm sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} RESTORA. All rights reserved.</p>
          <p className="s-num">Current release {release.version}</p>
        </div>
      </div>
    </footer>
  );
}
