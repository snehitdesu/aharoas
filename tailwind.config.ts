import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Professional, business-software palette (not landing-page gradients).
        brand: {
          50: "#eef4ff",
          100: "#d9e6ff",
          500: "#2563eb",
          600: "#1d4fd7",
          700: "#1a43b8",
        },
        ink: {
          900: "#0f172a",
          700: "#334155",
          500: "#64748b",
          300: "#cbd5e1",
          100: "#f1f5f9",
        },
        ok: { 500: "#16a34a", 100: "#dcfce7" },
        warn: { 500: "#d97706", 100: "#fef3c7" },
        bad: { 500: "#dc2626", 100: "#fee2e2" },
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "Arial", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
