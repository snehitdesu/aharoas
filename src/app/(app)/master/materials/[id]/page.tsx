import { gated } from "@/lib/auth/gate";
import { MaterialDetail } from "@/features/backoffice/master";

export const dynamic = "force-dynamic";
export const metadata = { title: "Material — Aharos" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return gated(`/master/materials/${id}`, () => <MaterialDetail id={id} />);
}
