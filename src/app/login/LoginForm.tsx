"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError, describeError } from "@/lib/api/client";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { authInput, authLabel } from "@/components/layout/AuthShell";
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
  const [missing, setMissing] = useState<{ email?: boolean; password?: boolean }>({});
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    // The button stays actionable; empty fields are explained instead of silently disabling it.
    const need = { email: !email.trim(), password: !password };
    if (need.email || need.password) {
      setMissing(need);
      setError(null);
      document.getElementById(need.email ? "email" : "password")?.focus();
      return;
    }
    setMissing({});
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
    <form onSubmit={submit} className="space-y-5" noValidate>
      <div>
        <label htmlFor="email" className={authLabel}>Email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          autoFocus
          required
          placeholder="you@restaurant.com"
          value={email}
          onChange={(e) => (setEmail(e.target.value), missing.email && setMissing((m) => ({ ...m, email: false })))}
          aria-invalid={missing.email || undefined}
          aria-describedby={missing.email ? "email-missing" : undefined}
          className={authInput}
        />
        {missing.email && <p id="email-missing" className="mt-1.5 text-[13px] text-bad-700">Enter your email address.</p>}
      </div>
      <div>
        <label htmlFor="password" className={authLabel}>Password</label>
        <div className="relative mt-1.5">
          <input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => (setPassword(e.target.value), missing.password && setMissing((m) => ({ ...m, password: false })))}
            aria-invalid={missing.password || undefined}
            aria-describedby={missing.password ? "password-missing" : undefined}
            className={`${authInput} !mt-0 pr-16`}
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-pressed={showPassword}
            aria-controls="password"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-[13px] font-medium text-ink-500 hover:bg-ink-100 hover:text-ink-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
          >
            {showPassword ? "Hide" : "Show"}
          </button>
        </div>
        {missing.password && <p id="password-missing" className="mt-1.5 text-[13px] text-bad-700">Enter your password.</p>}
        <div className="mt-2.5 flex justify-end">
          <Link href="/forgot-password" className="rounded text-[13.5px] font-medium text-brand-700 hover:text-brand-800 hover:underline">
            Forgot password?
          </Link>
        </div>
      </div>
      {error && (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-bad-100 bg-bad-50 px-3.5 py-2.5 text-sm text-bad-700">
          <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </p>
      )}
      <Button type="submit" variant="primary" size="lg" className="!h-12 w-full rounded-lg text-[15px] aria-busy:!cursor-wait aria-busy:!bg-brand-700 aria-busy:!text-white" loading={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
