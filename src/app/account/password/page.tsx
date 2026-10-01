import Link from "next/link";
import { requireShell } from "@/lib/auth/shell";
import { ChangePasswordForm } from "./ChangePasswordForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Change password — Aharos" };

export default async function ChangePasswordPage() {
  const { shell } = await requireShell("/account/password");
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-lg border border-ink-300 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold tracking-tight">Change password</h1>
        <p className="mb-5 mt-0.5 text-sm text-ink-500">{shell.user.email}</p>
        <ChangePasswordForm email={shell.user.email} />
        <Link href="/dashboard" className="mt-4 block text-center text-sm font-medium text-brand-700 hover:underline">Back to dashboard</Link>
      </div>
    </main>
  );
}
