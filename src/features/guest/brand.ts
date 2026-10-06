/**
 * Storefront branding for the guest (QR) website.
 *
 * The guest pages serve every restaurant on RESTORA; what they say about a
 * restaurant comes from its data (name, outlet, address, phone, hours, menu).
 * A brand profile adds only presentation — palette, tagline, the short "about"
 * line — and never facts: no invented hours, ratings, addresses or reviews.
 * A restaurant without a profile gets the neutral default with its own name.
 *
 * To brand another restaurant, add a profile here and match it in brandFor().
 */
export type BrandTheme = "coders" | "classic";

export type Brand = {
  theme: BrandTheme;
  /** Hero lines, shown large. */
  tagline: string[];
  /** Small strapline under the name (from the restaurant's own signage), or null. */
  strap: string | null;
  /** One or two sentences for the About section; must only restate what is true. */
  about: string | null;
  /** Browser UI colour on phones (address bar). */
  themeColor: string;
  /** Code-flavoured accents (terminal hero, mono labels) — Coders' Cafe only. */
  codeAccents: boolean;
};

const CODERS_CAFE: Brand = {
  theme: "coders",
  tagline: ["Good food.", "Good coffee.", "Good code."],
  // Printed under the logo on the café's menu boards.
  strap: "Brew · Muse · Play",
  about: "Pizzas, pasta, wings, nachos and more — order straight from your table, pay the way you like, and follow your order live while the kitchen works on it.",
  themeColor: "#5c151a",
  codeAccents: true,
};

const CLASSIC: Brand = {
  theme: "classic",
  tagline: ["Scan.", "Order.", "Enjoy."],
  strap: null,
  about: null,
  themeColor: "#923b1f",
  codeAccents: false,
};

const normalize = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();

/** The profile for a restaurant (by its name as stored in RESTORA). */
export function brandFor(restaurantName: string | null | undefined): Brand {
  const n = normalize(restaurantName ?? "");
  if (/\bcoders? ?(s )?cafe\b/.test(n) || n.replace(/ /g, "").includes("coderscafe")) return CODERS_CAFE;
  return CLASSIC;
}
