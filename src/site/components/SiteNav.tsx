"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { BrandMark } from "@/components/layout/BrandMark";
import { NAV } from "@/site/config";

/** Sticky top navigation. Desktop: horizontal links. Mobile: a disclosure menu (Escape closes, focus returns). */
export function SiteNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        toggle.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const current = (href: string) => (href !== "/" && !href.includes("#") && (pathname === href || pathname.startsWith(`${href}/`)) ? "page" : undefined);

  return (
    <header className="s-nav" data-scrolled={scrolled || open}>
      <nav aria-label="Main" className="s-wrap flex h-16 items-center gap-6">
        <Link href="/" className="flex items-center gap-2.5 no-underline" aria-label="RESTORA home">
          <BrandMark className="h-8 w-8" decorative />
          <span className="font-display text-[1.125rem] font-bold tracking-[0.14em] text-[color:var(--s-ink)]">RESTORA</span>
        </Link>

        <ul className="ml-2 hidden items-center gap-5 md:flex lg:ml-6 lg:gap-7">
          {NAV.map((n) => (
            <li key={n.href}>
              <Link href={n.href} className="s-nav-link" aria-current={current(n.href)}>
                {n.label}
              </Link>
            </li>
          ))}
        </ul>

        <div className="ml-auto flex items-center gap-3">
          <Link href="/login" className="s-nav-link hidden whitespace-nowrap sm:inline">
            Sign in
          </Link>
          <Link href="/download" className="s-btn s-btn-dark s-btn-sm hidden sm:inline-flex">
            Download
          </Link>
          <button
            ref={toggle}
            type="button"
            className="-mr-2 inline-flex h-11 w-11 items-center justify-center rounded-full md:hidden"
            aria-expanded={open}
            aria-controls="site-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((v) => !v)}
          >
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
              {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 8h16M4 16h16" />}
            </svg>
          </button>
        </div>
      </nav>

      <div id="site-menu" hidden={!open} className="md:hidden">
        <div className="s-wrap pb-6 pt-2">
          <ul className="grid">
            {NAV.map((n) => (
              <li key={n.href} className="s-rule">
                <Link href={n.href} className="block py-4 font-display text-2xl font-semibold text-[color:var(--s-ink)] no-underline" aria-current={current(n.href)} onClick={() => setOpen(false)}>
                  {n.label}
                </Link>
              </li>
            ))}
            <li className="s-rule">
              <Link href="/login" className="block py-4 font-display text-2xl font-semibold text-[color:var(--s-ink)] no-underline">
                Sign in
              </Link>
            </li>
          </ul>
          <Link href="/download" className="s-btn s-btn-primary mt-4 w-full">
            Download RESTORA
          </Link>
        </div>
      </div>
    </header>
  );
}
