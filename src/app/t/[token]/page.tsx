import { guestMenu } from "@/server/services/guestOrdering";
import { NotFoundError } from "@/server/db/scope";
import { GuestMenuScreen, type GuestMenuData } from "@/features/guest/components/GuestMenuScreen";

// Public guest page (scanned table QR). No session: the table token is the only
// input, resolved server-side to its outlet and organization.
export const dynamic = "force-dynamic";
export const metadata = { title: "Menu", robots: { index: false, follow: false } };

export default async function GuestTablePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let data: GuestMenuData;
  try {
    data = await guestMenu(token);
  } catch (e) {
    if (!(e instanceof NotFoundError)) throw e;
    return (
      <main className="mx-auto max-w-md px-6 py-20 text-center">
        <h1 className="text-lg font-bold">QR code not recognised</h1>
        <p className="mt-2 text-sm text-ink-600">{e.message}</p>
      </main>
    );
  }
  return <GuestMenuScreen token={token} initial={data} />;
}
