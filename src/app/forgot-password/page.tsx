import { ForgotPasswordForm } from "./ForgotPasswordForm";

export const metadata = { title: "Reset password — Aharos" };

export default function ForgotPasswordPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-lg border border-ink-300 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold tracking-tight">Reset your password</h1>
        <p className="mb-5 mt-0.5 text-sm text-ink-500">Enter the email you sign in with</p>
        <ForgotPasswordForm />
      </div>
    </main>
  );
}
