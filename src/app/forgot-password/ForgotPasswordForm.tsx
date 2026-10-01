"use client";

import { useState } from "react";
import Link from "next/link";
import { api, describeError } from "@/lib/api/client";
import { Button } from "@/components/ui/Button";
import { FormAlert, inputClass } from "@/components/auth/PasswordFields";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ message: string }>("/api/auth/password/reset", { method: "POST", body: { email } });
      setMessage(res.message);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {message ? (
        <FormAlert tone="success">{message}</FormAlert>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-ink-700">Email</label>
            <input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
          </div>
          {error && <FormAlert>{error}</FormAlert>}
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!email}>
            Request reset link
          </Button>
        </form>
      )}
      <Link href="/login" className="block text-center text-sm font-medium text-brand-700 hover:underline">Back to sign in</Link>
    </div>
  );
}
