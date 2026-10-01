import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Aharos — Restaurant Operating System",
  description: "Restaurant operating system: POS, inventory ledger, recipes, procurement, finance and analytics.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-ink-100 text-ink-900 font-sans antialiased">{children}</body>
    </html>
  );
}
