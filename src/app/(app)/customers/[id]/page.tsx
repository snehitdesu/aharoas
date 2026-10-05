import { gated } from "@/lib/auth/gate";
import { CustomerDetail } from "@/features/backoffice/crm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Customer — RESTORA" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return gated(`/customers/${id}`, () => <CustomerDetail id={id} />);
}
