"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, describeError } from "@/lib/api/client";
import { Button } from "@/components/ui/Button";
import { safeReturnPath } from "@/constants/auth";

/** Only same-origin relative paths are allowed as a post-login destination (no open redirect). */
export function safeNext(next: string | null | undefined): string {
  return safeReturnPath(next);
}

export function LoginForm({ next }: { next?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/login", { method: "POST", body: { email, password } });
      router.replace(safeNext(next));
      router.refresh();
    } catch (err) {
      // On the sign-in form a 401 means bad credentials, not an expired session.
      setError(err instanceof ApiError && err.kind === "unauthorized" ? err.message || "Invalid email or password" : describeError(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div>
        <label htmlFor="email" className="block text-sm font-medium text-ink-700">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 h-10 w-full rounded-md border border-ink-300 bg-white px-3 text-sm text-ink-900 placeholder:text-ink-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500" />
      </div>
      <div>
        <label htmlFor="password" className="block text-sm font-medium text-ink-700">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1 h-10 w-full rounded-md border border-ink-300 bg-white px-3 text-sm text-ink-900 placeholder:text-ink-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500" />
      </div>
      {error && (
        <p role="alert" className="rounded-md border border-bad-100 bg-bad-50 px-3 py-2 text-sm text-bad-700">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!email || !password}>
        Sign in
      </Button>
    </form>
  );
}
