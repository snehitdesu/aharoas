import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentContext } from "@/server/auth/current-user";
import { safeReturnPath } from "@/constants/auth";
import { AuthShell } from "@/components/layout/AuthShell";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in — Aharos" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  if (await getCurrentContext()) redirect(safeReturnPath(next));
  return (
    <AuthShell
      title="Aharos"
      subtitle="Sign in to your restaurant workspace"
      footer={
        <Link href="/forgot-password" className="mt-4 block text-center text-sm font-medium text-brand-700 hover:text-brand-800 hover:underline">
          Forgot password?
        </Link>
      }
    >
      <LoginForm next={next} />
    </AuthShell>
  );
}
