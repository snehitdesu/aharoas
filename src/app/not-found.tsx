import Link from "next/link";
import { BrandMark } from "@/components/layout/BrandMark";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-ink-50 p-6 text-center">
      <BrandMark className="mb-4 h-12 w-12" />
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-700">404</p>
      <h1 className="mt-1 text-xl font-semibold tracking-tight text-ink-900">Page not found</h1>
      <p className="mt-2 max-w-sm text-sm text-ink-500">That screen doesn&apos;t exist in RESTORA. Check the address or go back to the dashboard.</p>
      <Link href="/dashboard" className="mt-5 inline-flex h-10 items-center rounded-md bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700">
        Back to dashboard
      </Link>
    </main>
  );
}
