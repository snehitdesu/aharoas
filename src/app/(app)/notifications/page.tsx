import { gated } from "@/lib/auth/gate";
import { NotificationsScreen } from "@/features/backoffice/alerts";

export const dynamic = "force-dynamic";
export const metadata = { title: "Notifications — Aharos" };

export default function Page() {
  return gated("/notifications", () => <NotificationsScreen />);
}
