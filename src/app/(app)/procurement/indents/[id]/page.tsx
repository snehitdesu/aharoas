import { gated } from "@/lib/auth/gate";
import { IndentDetail } from "@/features/backoffice/procurement";

export const dynamic = "force-dynamic";
export const metadata = { title: "Indent — RESTORA" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return gated(`/procurement/indents/${id}`, () => <IndentDetail id={id} />);
}
