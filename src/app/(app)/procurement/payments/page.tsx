import { gated } from "@/lib/auth/gate";
import { VendorPaymentsScreen } from "@/features/backoffice/procurement";

export const dynamic = "force-dynamic";
export const metadata = { title: "Vendor payments — RESTORA" };

export default function Page() {
  return gated("/procurement/payments", () => <VendorPaymentsScreen />);
}
