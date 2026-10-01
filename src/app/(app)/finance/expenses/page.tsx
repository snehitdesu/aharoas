import { gated } from "@/lib/auth/gate";
import { ExpensesScreen } from "@/features/backoffice/finance";

export const dynamic = "force-dynamic";
export const metadata = { title: "Expenses — Aharos" };

export default function Page() {
  return gated("/finance/expenses", () => <ExpensesScreen />);
}
