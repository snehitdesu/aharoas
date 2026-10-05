import { gated } from "@/lib/auth/gate";
import { FeedbackScreen } from "@/features/backoffice/crm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Guest feedback — RESTORA" };

export default function Page() {
  return gated("/customers/feedback", () => <FeedbackScreen />);
}
