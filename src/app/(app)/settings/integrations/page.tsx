import { gated } from "@/lib/auth/gate";
import { IntegrationsScreen } from "@/features/backoffice/integrations";

export const dynamic = "force-dynamic";
export const metadata = { title: "Integrations — RESTORA" };

export default function Page() {
  return gated("/settings/integrations", () => <IntegrationsScreen />);
}
