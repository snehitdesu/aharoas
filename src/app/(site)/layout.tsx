import type { Metadata } from "next";
import { Instrument_Sans } from "next/font/google";
import { SiteNav } from "@/site/components/SiteNav";
import { SiteFooter } from "@/site/components/SiteFooter";
import { RevealController } from "@/site/components/Reveal";
import { SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE, SITE_URL } from "@/site/config";
import "./site.css";

// Website body face (the application itself keeps its own UI font). Self-hosted by next/font.
const siteSans = Instrument_Sans({ subsets: ["latin"], display: "swap", variable: "--font-site" });

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: `${SITE_NAME}: ${SITE_TAGLINE}`, template: `%s | ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title: `${SITE_NAME}: ${SITE_TAGLINE}`,
    description: SITE_DESCRIPTION,
    images: [{ url: "/site/og.png", width: 1200, height: 630, alt: "RESTORA, the operating system for restaurants" }],
  },
  twitter: { card: "summary_large_image", title: `${SITE_NAME}: ${SITE_TAGLINE}`, description: SITE_DESCRIPTION, images: ["/site/og.png"] },
  robots: { index: true, follow: true },
};

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`site ${siteSans.variable}`}>
      <a href="#main" className="s-skip">
        Skip to content
      </a>
      <SiteNav />
      <main id="main">{children}</main>
      <SiteFooter />
      <RevealController />
    </div>
  );
}
