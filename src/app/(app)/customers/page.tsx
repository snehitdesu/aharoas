import { gated } from "@/lib/auth/gate";
import { CustomersScreen } from "@/features/backoffice/crm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Customers — Aharos" };

export default function Page() {
  return gated("/customers", () => <CustomersScreen />);
}
