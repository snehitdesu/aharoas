import { redirect } from "next/navigation";
import { getCurrentContext } from "@/server/auth/current-user";
import { safeReturnPath } from "@/constants/auth";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in — Aharos" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  if (await getCurrentContext()) redirect(safeReturnPath(next)); // server-safe helper (safeNext lives in a client module)
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-lg border border-ink-300 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold tracking-tight">Aharos</h1>
        <p className="mb-5 mt-0.5 text-sm text-ink-500">Sign in to your restaurant workspace</p>
        <LoginForm next={next} />
      </div>
    </main>
  );
}
