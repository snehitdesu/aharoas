import type { Config } from "tailwindcss";

/**
 * RESTORA design tokens — "The Operating System for Restaurants".
 *
 * Direction: retro-modern editorial. A warm ivory / beige paper foundation,
 * espresso-brown ink, terracotta as the single action colour, saffron for
 * highlights, and muted, earthy semantics (sage, ochre, brick, teal) so status
 * colours stay legible on paper without shouting. Every scale is consumed by
 * the component primitives (Button, Badge, Card, DataTable, …): one change here
 * re-themes the whole application. Contrast (WCAG 2.1) was checked for every
 * text/background pair the primitives use — body and muted text ≥ 4.5:1 on
 * page and paper, ink-400 (icons / placeholders / disabled only) ≥ 3:1.
 *
 * Scale names are kept from the first identity (brand / vanilla / accent / ink
 * / ok / warn / bad / info) so no screen needs to change its class names.
 *
 * - `brand`   — terracotta. Primary actions, active navigation, links, focus.
 *               600 sits behind white text (5.4:1); 700 is the link / text shade.
 * - `vanilla` / `accent` — saffron highlight (pair with dark ink text only).
 * - `ink`     — espresso neutral ramp: 50 = page, 900 = headline ink.
 * - `paper`   — card / surface ivory (lighter than the page).
 * - `espresso`— the dark chrome (side navigation, operator bar, toasts).
 * - `ok / warn / bad / info` — sage / ochre / brick / teal.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Terracotta — the action colour.
        brand: {
          50: "#fbefe8",
          100: "#f6dccd",
          200: "#ecbaa1",
          300: "#e09474",
          400: "#d47552",
          500: "#c85a35", // identity terracotta — accents, focus ring, active marks
          600: "#b04a29", // primary button (white text 5.4:1)
          700: "#923b1f", // hover / links / text on tints (7.2:1 on paper)
          800: "#76301b",
          900: "#5c2817",
        },
        // Saffron — warm highlight (with ink text only).
        vanilla: {
          50: "#fefaf0",
          100: "#fbefd2",
          200: "#f6dfa3",
          300: "#efca6e",
          400: "#e4b048",
          500: "#cf942b",
          600: "#a9741a",
          700: "#86580f",
        },
        accent: {
          50: "#fefaf0",
          100: "#fbefd2",
          200: "#f6dfa3",
          300: "#efca6e",
          400: "#e4b048",
          500: "#cf942b",
          600: "#a9741a",
          700: "#86580f",
        },
        // Espresso neutral ramp — text, rules, surfaces.
        ink: {
          50: "#f6f0e4", // page (warm ivory-beige)
          100: "#efe6d6", // sunken / hover
          200: "#e6dac6", // hairlines
          300: "#d4c4ac", // borders
          400: "#8c7964", // icons, placeholders, disabled (≥ 3:1)
          500: "#76634f", // muted text (≥ 5:1)
          600: "#5f4d3d",
          700: "#4a3a2c",
          800: "#352619",
          900: "#24180f", // headline ink
        },
        paper: {
          DEFAULT: "#fffcf6",
          warm: "#fbf6ec",
        },
        espresso: {
          DEFAULT: "#24180f",
          800: "#2e2016",
          700: "#3b2a1d",
          600: "#4d3828",
        },
        // Semantic — earthy, legible on paper.
        ok: { 50: "#eef3e8", 100: "#d5e3c8", 500: "#4c7a3b", 600: "#3d6a2f", 700: "#30552a" },
        warn: { 50: "#fcf1dd", 100: "#f6dfb2", 500: "#b4741a", 600: "#965c10", 700: "#7a4a0c" },
        bad: { 50: "#fbe9e5", 100: "#f3c9c0", 500: "#c0392b", 600: "#a52a1f", 700: "#86221a" },
        info: { 50: "#e9f2f1", 100: "#cbe0de", 500: "#327574", 600: "#2b6463", 700: "#22504f" },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "Arial", "sans-serif"],
        display: ["var(--font-display)", "Georgia", "Cambria", "Times New Roman", "serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      borderRadius: {
        md: "0.375rem",
        lg: "0.5rem",
        xl: "0.75rem",
        "2xl": "1rem",
      },
      boxShadow: {
        xs: "0 1px 0 0 rgb(36 24 15 / 0.06)",
        card: "0 1px 0 0 rgb(36 24 15 / 0.05), 0 1px 3px 0 rgb(36 24 15 / 0.06)",
        raised: "0 2px 0 0 rgb(36 24 15 / 0.05), 0 8px 20px -10px rgb(36 24 15 / 0.22)",
        pop: "0 14px 34px -10px rgb(36 24 15 / 0.30), 0 2px 8px -4px rgb(36 24 15 / 0.14)",
        // Retro "printed" offset shadow for emphasis surfaces (hero KPI, dialogs).
        print: "3px 3px 0 0 rgb(36 24 15 / 0.9)",
        focus: "0 0 0 3px rgb(200 90 53 / 0.35)",
      },
      letterSpacing: {
        eyebrow: "0.14em",
      },
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "slide-up": { from: { opacity: "0", transform: "translateY(6px)" }, to: { opacity: "1", transform: "translateY(0)" } },
        "scale-in": { from: { opacity: "0", transform: "scale(0.98)" }, to: { opacity: "1", transform: "scale(1)" } },
        shimmer: { "100%": { transform: "translateX(100%)" } },
      },
      animation: {
        "fade-in": "fade-in 0.15s ease-out",
        "slide-up": "slide-up 0.18s ease-out",
        "scale-in": "scale-in 0.14s ease-out",
      },
    },
  },
  plugins: [],
};

export default config;
