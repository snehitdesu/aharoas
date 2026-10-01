import type { Config } from "tailwindcss";

/**
 * Aharos design tokens.
 *
 * Brand identity: Moonstone (#4C9DB0) + Vanilla (#FFEBAF) over a mature, slightly
 * cool neutral base so the two brand colors read as intentional accents, never
 * wallpaper. Scales are consumed by the component primitives (Button, Badge,
 * Card, DataTable, …) so a single change here re-themes the whole application.
 *
 * - `brand`  — Moonstone. Active state, links, focus ring, primary actions.
 *              500 is the pure identity colour; 600/700 are the deeper,
 *              AA-contrast shades used behind white button text.
 * - `vanilla`/`accent` — warm highlight. KPI emphasis, selected rows, premium
 *              moments. Always paired with dark ink text, never used for text.
 * - `ink`    — neutral text/surface/border ramp.
 * - `ok/warn/bad/info` — semantic. `warn` is pushed toward amber so it never
 *              collides with Vanilla.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Moonstone — core brand / interactive identity.
        brand: {
          50: "#eff6f8",
          100: "#d7eaef",
          200: "#b2d6de",
          300: "#85bfcb",
          400: "#63aabc",
          500: "#4c9db0", // pure Moonstone — tints, focus ring, accents
          600: "#357d90", // primary button bg (AA on white text)
          700: "#2b6475", // hover / active
          800: "#27525f",
          900: "#234650",
        },
        // Vanilla — warm highlight accent (pair with ink text only).
        vanilla: {
          50: "#fffdf5",
          100: "#fff8e3",
          200: "#ffebaf", // pure Vanilla
          300: "#fbd97a",
          400: "#f2c44d",
          500: "#e3a92b",
          600: "#bd8416",
          700: "#946709",
        },
        accent: {
          50: "#fffdf5",
          100: "#fff8e3",
          200: "#ffebaf",
          300: "#fbd97a",
          400: "#f2c44d",
          500: "#e3a92b",
          600: "#bd8416",
          700: "#946709",
        },
        // Neutral ramp — text, surfaces, borders.
        ink: {
          50: "#f7f9fa",
          100: "#eef1f3",
          200: "#e2e7ea",
          300: "#cfd6db",
          400: "#9aa4ac",
          500: "#6b7681",
          600: "#515b64",
          700: "#3c454c",
          800: "#283036",
          900: "#141a1f",
        },
        // Semantic.
        ok: { 50: "#e9f6ef", 100: "#cdebdb", 500: "#15935e", 600: "#0f7a4d", 700: "#0c5f3d" },
        warn: { 50: "#fdf2df", 100: "#f9e2b8", 500: "#b8730c", 600: "#9a5f09", 700: "#7a4b08" },
        bad: { 50: "#fbe9e7", 100: "#f6cfca", 500: "#d1443e", 600: "#b5342f", 700: "#8f2824" },
        info: { 50: "#eff6f8", 100: "#d7eaef", 500: "#357d90", 600: "#2b6475", 700: "#234650" },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "Arial", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      borderRadius: {
        md: "0.5rem",
        lg: "0.625rem",
        xl: "0.875rem",
        "2xl": "1.125rem",
      },
      boxShadow: {
        xs: "0 1px 2px 0 rgb(20 26 31 / 0.05)",
        card: "0 1px 2px 0 rgb(20 26 31 / 0.04), 0 1px 3px 0 rgb(20 26 31 / 0.06)",
        raised: "0 2px 6px -2px rgb(20 26 31 / 0.10), 0 6px 16px -6px rgb(20 26 31 / 0.10)",
        pop: "0 10px 30px -8px rgb(20 26 31 / 0.18), 0 2px 8px -4px rgb(20 26 31 / 0.10)",
        focus: "0 0 0 3px rgb(76 157 176 / 0.35)",
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
