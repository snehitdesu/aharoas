import { gated } from "@/lib/auth/gate";
import { VendorDetail } from "@/features/backoffice/master";

export const dynamic = "force-dynamic";
export const metadata = { title: "Vendor — RESTORA" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return gated(`/master/vendors/${id}`, () => <VendorDetail id={id} />);
}
