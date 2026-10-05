import { gated } from "@/lib/auth/gate";
import { IndentsScreen } from "@/features/backoffice/procurement";

export const dynamic = "force-dynamic";
export const metadata = { title: "Indents — RESTORA" };

export default function Page() {
  return gated("/procurement/indents", () => <IndentsScreen />);
}
