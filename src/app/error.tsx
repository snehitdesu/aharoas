"use client";

import { useEffect } from "react";
import Link from "next/link";
import { BrandMark } from "@/components/layout/BrandMark";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-ink-50 p-6 text-center">
      <BrandMark className="mb-4 h-12 w-12" />
      <h1 className="text-xl font-semibold tracking-tight text-ink-900">Something went wrong</h1>
      <p className="mt-2 max-w-sm text-sm text-ink-500">RESTORA hit an unexpected error. Try again, or return to the dashboard. If this keeps happening, tell a manager.</p>
      <div className="mt-5 flex gap-2">
        <button type="button" onClick={reset} className="inline-flex h-10 items-center rounded-md bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700">
          Try again
        </button>
        <Link href="/dashboard" className="inline-flex h-10 items-center rounded-md border border-ink-300 bg-paper px-4 text-sm font-medium text-ink-800 hover:bg-ink-50">
          Back to dashboard
        </Link>
      </div>
    </main>
  );
}
