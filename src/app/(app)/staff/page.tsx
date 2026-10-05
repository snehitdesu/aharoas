import { gated } from "@/lib/auth/gate";
import { TeamScreen } from "@/features/backoffice/staff";

export const dynamic = "force-dynamic";
export const metadata = { title: "Team — RESTORA" };

export default function Page() {
  return gated("/staff", () => <TeamScreen />);
}
