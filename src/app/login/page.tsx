import { redirect } from "next/navigation";
import { getCurrentContext } from "@/server/auth/current-user";
import { safeReturnPath } from "@/constants/auth";
import { AuthShell } from "@/components/layout/AuthShell";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in — RESTORA" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  if (await getCurrentContext()) redirect(safeReturnPath(next));
  return (
    <AuthShell title="Welcome back" subtitle="Sign in to your restaurant workspace." help="Need access? Ask your restaurant owner or manager.">
      <LoginForm next={next} />
    </AuthShell>
  );
}
