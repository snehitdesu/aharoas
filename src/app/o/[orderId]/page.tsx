import { GuestOrderScreen } from "@/features/guest/components/GuestOrderScreen";
import "@/features/guest/storefront.css";

// Public guest order page. The access key travels in the URL fragment (#k=…),
// which browsers never send to the server; the client sends it as a header.
export const dynamic = "force-dynamic";
export const metadata = { title: "Your order", robots: { index: false, follow: false }, referrer: "no-referrer" };
export const viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default async function GuestOrderPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  return <GuestOrderScreen orderId={orderId} />;
}
