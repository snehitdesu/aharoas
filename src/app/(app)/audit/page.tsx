import { gated } from "@/lib/auth/gate";
import { AuditScreen } from "@/features/backoffice/admin";

export const dynamic = "force-dynamic";
export const metadata = { title: "Audit log — Aharos" };

export default function Page() {
  return gated("/audit", () => <AuditScreen />);
}
