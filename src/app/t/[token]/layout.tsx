import type { Metadata, Viewport } from "next";
import { cache, type ReactNode } from "react";
import { guestMenu } from "@/server/services/guestOrdering";
import { NotFoundError } from "@/server/db/scope";
import { StorefrontProvider, type GuestMenuData } from "@/features/guest/storefront";
import { StorefrontOverlays } from "@/features/guest/components/Chrome";
import { SfIcon } from "@/features/guest/components/SfIcon";
import { brandFor } from "@/features/guest/brand";
import "@/features/guest/storefront.css";

// Public guest website for one table (its QR code). No session: the table token
// is the only input, resolved server-side to restaurant → outlet → table.
export const dynamic = "force-dynamic";

/** One server lookup per request, shared by the metadata and the layout. */
const load = cache(async (token: string): Promise<GuestMenuData | null> => {
  try {
    return (await guestMenu(token)) as GuestMenuData;
  } catch (e) {
    if (e instanceof NotFoundError) return null;
    throw e;
  }
});

type Props = { params: Promise<{ token: string }>; children: ReactNode };

export async function generateMetadata({ params }: Omit<Props, "children">): Promise<Metadata> {
  const data = await load((await params).token);
  return {
    title: data ? `${data.restaurant.name} · Table ${data.table.code}` : "Table QR",
    description: data ? `Order from Table ${data.table.code} at ${data.restaurant.name}.` : undefined,
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

export async function generateViewport({ params }: Omit<Props, "children">): Promise<Viewport> {
  const data = await load((await params).token);
  return { themeColor: brandFor(data?.restaurant.name).themeColor, width: "device-width", initialScale: 1, viewportFit: "cover" };
}

export default async function GuestTableLayout({ params, children }: Props) {
  const { token } = await params;
  const data = await load(token);
  if (!data) return <InvalidQr />;
  const brand = brandFor(data.restaurant.name);
  return (
    <div className="sf" data-theme={brand.theme}>
      <StorefrontProvider token={token} initial={data}>
        {children}
        <StorefrontOverlays />
      </StorefrontProvider>
    </div>
  );
}

/** Unknown, rotated or disabled QR, or a restaurant that is not active: one message (no hint about which). */
function InvalidQr() {
  return (
    <div className="sf" data-theme="classic">
      <main className="sf-notice">
        <div className="sf-notice-card">
          <div className="sf-notice-ico">
            <SfIcon name="qr" />
          </div>
          <h1>This QR code isn&apos;t working</h1>
          <p>It may have been replaced or switched off. Please ask a member of staff — they can help you order.</p>
          <span className="sf-mono">QR code not recognised</span>
        </div>
      </main>
    </div>
  );
}
