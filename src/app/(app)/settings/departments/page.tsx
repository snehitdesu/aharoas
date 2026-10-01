import { gated } from "@/lib/auth/gate";
import { DepartmentsScreen } from "@/features/backoffice/admin";

export const dynamic = "force-dynamic";
export const metadata = { title: "Departments — Aharos" };

export default function Page() {
  return gated("/settings/departments", () => <DepartmentsScreen />);
}
