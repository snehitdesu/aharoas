import { GuestOrderScreen } from "@/features/guest/components/GuestOrderScreen";

// Public guest order page. The access key travels in the URL fragment (#k=…),
// which browsers never send to the server; the client sends it as a header.
export const dynamic = "force-dynamic";
export const metadata = { title: "Your order", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function GuestOrderPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  return <GuestOrderScreen orderId={orderId} />;
}
