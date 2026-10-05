import { gated } from "@/lib/auth/gate";
import { VendorsScreen } from "@/features/backoffice/master";

export const dynamic = "force-dynamic";
export const metadata = { title: "Vendors — RESTORA" };

export default function Page() {
  return gated("/master/vendors", () => <VendorsScreen />);
}
