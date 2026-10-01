import { AuthShell } from "@/components/layout/AuthShell";
import { SetPasswordForm } from "./SetPasswordForm";

export const metadata = { title: "Set your password — Aharos" };

/**
 * Landing page for one-time setup / reset links: /set-password#token=…
 * The token is in the URL fragment, which browsers never send to the server
 * (no server logs, no Referer); the form posts it to /api/auth/password/complete.
 */
export default function SetPasswordPage() {
  return (
    <AuthShell title="Set your password" subtitle="Choose a password for your Aharos account">
      <SetPasswordForm />
    </AuthShell>
  );
}
