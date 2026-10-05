import { gated } from "@/lib/auth/gate";
import { TasksScreen } from "@/features/backoffice/staff";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tasks — RESTORA" };

export default function Page() {
  return gated("/staff/tasks", () => <TasksScreen />);
}
