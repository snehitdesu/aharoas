"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { REAUTH_SCOPES, isReauthScope } from "@/constants/auth";
import { ApiError, request, setReauthPrompt, type ReauthOutcome } from "@/lib/api/client";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { FormAlert, Input } from "@/components/ui/Form";

type Pending = { scope: string; reason: string; resolve: (o: ReauthOutcome) => void };

/** Desktop shell bridge (desktop/preload/app.ts): the main process asks for a confirmation (backup restore). */
type DesktopBridge = { onReauthRequest?: (handler: (scope: string) => Promise<ReauthOutcome>) => () => void };

/**
 * Step-up re-authentication UI. Installs the prompt used by `api()` when a
 * sensitive endpoint answers ReauthRequiredError: asks for the CURRENT user's
 * password, posts it (JSON body, never the URL) to /api/auth/reauth, and
 * resolves "granted" only when the server confirms the grant. The password
 * lives in component state only while the dialog is open and is wiped after
 * every attempt; it is never logged or stored.
 */
export function ReauthProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [busy, setBusy] = useState(false);
  const pendingRef = useRef<Pending | null>(null);

  const reset = () => {
    setPassword("");
    setError(null);
    setSessionEnded(false);
    setBusy(false);
  };

  const prompt = useCallback(({ scope, message }: { scope: string; message?: string }) => {
    return new Promise<ReauthOutcome>((resolve) => {
      // A different scope arriving while a dialog is open: the earlier request is cancelled (nothing ran).
      pendingRef.current?.resolve("cancelled");
      const reason = isReauthScope(scope) ? `Confirm your password to ${REAUTH_SCOPES[scope]}.` : message || "Confirm your password to continue.";
      const p: Pending = { scope, reason, resolve };
      pendingRef.current = p;
      reset();
      setPending(p);
    });
  }, []);

  const finish = useCallback((outcome: ReauthOutcome) => {
    const p = pendingRef.current;
    pendingRef.current = null;
    reset();
    setPending(null);
    p?.resolve(outcome);
  }, []);

  useEffect(() => setReauthPrompt(prompt), [prompt]);
  useEffect(() => {
    const bridge = (globalThis as { aharosDesktop?: DesktopBridge }).aharosDesktop;
    return bridge?.onReauthRequest?.((scope) => prompt({ scope }));
  }, [prompt]);
  // Never leave a caller hanging (or a password in memory) if the provider unmounts.
  useEffect(() => () => pendingRef.current?.resolve("cancelled"), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const p = pendingRef.current;
    if (!p || busy || !password) return;
    const secret = password;
    setPassword(""); // cleared before the request: nothing lingers in the field whatever the outcome
    setBusy(true);
    setError(null);
    try {
      await request("/api/auth/reauth", { method: "POST", body: { password: secret, scope: p.scope } });
      if (pendingRef.current === p) finish("granted");
    } catch (err) {
      if (pendingRef.current !== p) return;
      setBusy(false);
      if (err instanceof ApiError && err.status === 401) {
        setSessionEnded(true);
        setError("Your session has ended. Sign in again to continue — nothing was changed.");
      } else if (err instanceof ApiError && err.status === 422) {
        setError("That password is incorrect. Nothing was changed.");
      } else if (err instanceof ApiError && err.status === 429) {
        setError(`Too many attempts. Try again in ${err.retryAfterSeconds ?? 60}s.`);
      } else {
        setError(err instanceof ApiError ? err.message : "Could not confirm your password. Try again.");
      }
    }
  };

  const close = () => !busy && finish(sessionEnded ? "session_ended" : "cancelled");
  const loginHref = typeof window !== "undefined" ? `/login?next=${encodeURIComponent(window.location.pathname)}` : "/login";

  return (
    <>
      {children}
      <Dialog
        open={!!pending}
        onClose={close}
        title="Confirm your password"
        description={pending?.reason}
        size="sm"
        footer={
          sessionEnded ? (
            <>
              <Button onClick={close}>Close</Button>
              <a href={loginHref} className="inline-flex h-9 items-center rounded-md bg-brand-600 px-3 text-sm font-medium text-white hover:bg-brand-700">Sign in again</a>
            </>
          ) : (
            <>
              <Button onClick={close} disabled={busy}>Cancel</Button>
              <Button type="submit" form="reauth-form" variant="primary" loading={busy} disabled={!password}>Confirm</Button>
            </>
          )
        }
      >
        <form id="reauth-form" method="post" action="#" onSubmit={submit} autoComplete="off" data-testid="reauth-dialog">
          <FormAlert message={error} />
          <p className="mb-3 text-sm text-ink-600">This is a sensitive action. For your security, re-enter the password you use to sign in. Your password is checked by the server and is not saved.</p>
          {!sessionEnded && (
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-ink-700">Current password</span>
              <Input type="password" name="current-password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} data-autofocus required maxLength={200} aria-label="Current password" />
            </label>
          )}
        </form>
      </Dialog>
    </>
  );
}
