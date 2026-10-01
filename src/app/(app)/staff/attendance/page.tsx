import { gated } from "@/lib/auth/gate";
import { AttendanceScreen } from "@/features/backoffice/staff";

export const dynamic = "force-dynamic";
export const metadata = { title: "Attendance — Aharos" };

export default function Page() {
  return gated("/staff/attendance", () => <AttendanceScreen />);
}
