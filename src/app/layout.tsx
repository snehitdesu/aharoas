import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "Aharos — Restaurant Operating System",
  description: "Restaurant operating system: POS, inventory ledger, recipes, procurement, finance and analytics.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="bg-ink-50 text-ink-900 font-sans antialiased">{children}</body>
    </html>
  );
}
