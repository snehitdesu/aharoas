import { gated } from "@/lib/auth/gate";
import { OrganizationScreen } from "@/features/backoffice/admin";

export const dynamic = "force-dynamic";
export const metadata = { title: "Organization — Aharos" };

export default function Page() {
  return gated("/settings/organization", () => <OrganizationScreen />);
}
