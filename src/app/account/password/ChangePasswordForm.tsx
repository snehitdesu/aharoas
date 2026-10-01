"use client";

import { useState } from "react";
import { api } from "@/lib/api/client";
import { Button } from "@/components/ui/Button";
import { PasswordInput, FormAlert, PASSWORD_HINT, passwordErrorMessage } from "@/components/auth/PasswordFields";

export function ChangePasswordForm({ email }: { email: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (next !== confirm) return setError("The new passwords do not match");
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ sessionsRevoked: number }>("/api/auth/password/change", { method: "POST", body: { currentPassword: current, newPassword: next } });
      setDone(`Password changed.${res.sessionsRevoked ? ` Signed out ${res.sessionsRevoked} other session${res.sessionsRevoked === 1 ? "" : "s"}.` : ""}`);
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      setError(passwordErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <input type="hidden" name="username" autoComplete="username" value={email} readOnly />
      <PasswordInput id="current-password" label="Current password" value={current} onChange={setCurrent} autoComplete="current-password" />
      <PasswordInput id="new-password" label="New password" value={next} onChange={setNext} autoComplete="new-password" hint={PASSWORD_HINT} />
      <PasswordInput id="confirm-password" label="Repeat new password" value={confirm} onChange={setConfirm} autoComplete="new-password" />
      {error && <FormAlert>{error}</FormAlert>}
      {done && <FormAlert tone="success">{done}</FormAlert>}
      <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!current || !next || !confirm}>
        Change password
      </Button>
    </form>
  );
}
