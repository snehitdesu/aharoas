/**
 * Public website configuration.
 *
 * SITE_URL is the canonical origin used for metadata, the sitemap and Open
 * Graph. It is not known yet (no production domain has been chosen), so it
 * comes from the environment; the localhost fallback keeps development working
 * and is never presented as a real domain.
 */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/+$/, "");

export const SITE_NAME = "RESTORA";
export const SITE_TAGLINE = "The Operating System for Restaurants";
export const SITE_DESCRIPTION =
  "RESTORA is restaurant management software that runs POS, QR ordering, kitchen display, inventory, procurement, finance and analytics as one connected system, on the web and as a Windows desktop app.";

/** Where "Open RESTORA" (the web application) sends visitors. Same deployment by default. */
export const WEB_APP_PATH = "/login";

export const NAV = [
  { href: "/product", label: "Product" },
  { href: "/solutions", label: "Solutions" },
  { href: "/#demo", label: "Demo" },
  { href: "/resources", label: "Resources" },
] as const;

export const FOOTER = [
  {
    title: "Product",
    links: [
      { href: "/product/pos", label: "POS" },
      { href: "/product/qr-ordering", label: "QR ordering" },
      { href: "/product/kitchen", label: "Kitchen (KOT and KDS)" },
      { href: "/product/inventory", label: "Inventory" },
      { href: "/product/procurement", label: "Procurement" },
      { href: "/product/finance", label: "Finance" },
      { href: "/product/analytics", label: "Analytics" },
      { href: "/product/staff", label: "Staff and roles" },
      { href: "/product/integrations", label: "Integrations" },
    ],
  },
  {
    title: "Get RESTORA",
    links: [
      { href: "/download", label: "Download" },
      { href: WEB_APP_PATH, label: "Open RESTORA Web" },
      { href: "/#demo", label: "Interactive demo" },
      { href: "/solutions", label: "Solutions" },
    ],
  },
  {
    title: "Resources",
    links: [
      { href: "/resources", label: "Resources" },
      { href: "/resources/release-notes", label: "Release notes" },
      { href: "/download#requirements", label: "System requirements" },
      { href: "/security", label: "Security" },
    ],
  },
  {
    title: "Legal",
    links: [
      { href: "/privacy", label: "Privacy Policy" },
      { href: "/terms", label: "Terms of Service" },
    ],
  },
] as const;
