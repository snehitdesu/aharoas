import { gated } from "@/lib/auth/gate";
import { IssueDetail } from "@/features/backoffice/inventory";

export const dynamic = "force-dynamic";
export const metadata = { title: "Stock issue — Aharos" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return gated(`/inventory/issues/${id}`, () => <IssueDetail id={id} />);
}
