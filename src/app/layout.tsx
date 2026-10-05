import type { Metadata } from "next";
import { Fraunces, Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

// Editorial display serif for headings (self-hosted at build time by next/font: no runtime CDN, CSP font-src 'self').
const display = Fraunces({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-display",
  axes: ["opsz", "SOFT"],
});

export const metadata: Metadata = {
  title: "RESTORA — The Operating System for Restaurants",
  description: "RESTORA: POS, QR ordering, kitchen display, inventory, procurement, finance and analytics for restaurants.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${display.variable}`}>
      <body className="bg-ink-50 text-ink-900 font-sans antialiased">{children}</body>
    </html>
  );
}
