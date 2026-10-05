import { AuthShell } from "@/components/layout/AuthShell";
import { ForgotPasswordForm } from "./ForgotPasswordForm";

export const metadata = { title: "Reset password — RESTORA" };

export default function ForgotPasswordPage() {
  return (
    <AuthShell title="Reset your password" subtitle="Enter the email you sign in with">
      <ForgotPasswordForm />
    </AuthShell>
  );
}
