import { gated } from "@/lib/auth/gate";
import { IssuesScreen } from "@/features/backoffice/inventory";

export const dynamic = "force-dynamic";
export const metadata = { title: "Stock issues — RESTORA" };

export default function Page() {
  return gated("/inventory/issues", () => <IssuesScreen />);
}
