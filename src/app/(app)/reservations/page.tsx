import { gated } from "@/lib/auth/gate";
import { ReservationsScreen } from "@/features/backoffice/reservations";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reservations — RESTORA" };

export default function Page() {
  return gated("/reservations", () => <ReservationsScreen />);
}
