import Link from "next/link";
import { requireShell } from "@/lib/auth/shell";
import { AuthShell } from "@/components/layout/AuthShell";
import { ChangePasswordForm } from "./ChangePasswordForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Change password — Aharos" };

export default async function ChangePasswordPage() {
  const { shell } = await requireShell("/account/password");
  return (
    <AuthShell
      title="Change password"
      subtitle={shell.user.email}
      footer={
        <Link href="/dashboard" className="mt-4 block text-center text-sm font-medium text-brand-700 hover:text-brand-800 hover:underline">
          Back to dashboard
        </Link>
      }
    >
      <ChangePasswordForm email={shell.user.email} />
    </AuthShell>
  );
}
