import { gated } from "@/lib/auth/gate";
import { LeaveScreen } from "@/features/backoffice/staff";

export const dynamic = "force-dynamic";
export const metadata = { title: "Leave — RESTORA" };

export default function Page() {
  return gated("/staff/leave", () => <LeaveScreen />);
}
