import { SetPasswordForm } from "./SetPasswordForm";

export const metadata = { title: "Set your password — Aharos" };

/**
 * Landing page for one-time setup / reset links: /set-password#token=…
 * The token is in the URL fragment, which browsers never send to the server
 * (no server logs, no Referer); the form posts it to /api/auth/password/complete.
 */
export default function SetPasswordPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-lg border border-ink-300 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold tracking-tight">Set your password</h1>
        <p className="mb-5 mt-0.5 text-sm text-ink-500">Choose a password for your Aharos account</p>
        <SetPasswordForm />
      </div>
    </main>
  );
}
