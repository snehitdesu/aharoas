import { prisma } from "@/server/db/client";
import { requireShell } from "@/lib/auth/shell";
import { getOrderBill } from "@/server/services/bill";
import { ForbiddenError, NotFoundError } from "@/server/db/scope";
import { ForbiddenPage } from "@/components/ui/States";
import { BillView } from "@/features/billing/BillView";
import { PrintButton } from "@/features/billing/PrintButton";
import { PrinterActions } from "@/features/billing/PrinterActions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Bill — RESTORA" };

/** Printable bill / receipt for one order (view, print, reprint). Same authorization as GET /api/orders/:id/bill. */
export default async function PosBillPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const { ctx } = await requireShell(`/pos/bill/${orderId}`);
  let bill;
  try {
    bill = await getOrderBill(prisma, ctx, orderId);
  } catch (e) {
    if (e instanceof NotFoundError || e instanceof ForbiddenError) return <ForbiddenPage title="Bill not available" reason="This order doesn't exist or isn't at an outlet you can access." />;
    throw e;
  }
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { outletId: true } });
  const hasPrinter = (await prisma.printer.count({ where: { organizationId: ctx.organizationId, outletId: order.outletId, role: "RECEIPT", active: true } })) > 0;
  return (
    <main className="min-h-screen bg-ink-100 py-6 print:bg-paper print:py-0">
      <div className="mx-auto mb-4 flex max-w-md items-center justify-between gap-2 px-4 print:hidden">
        <a href="/pos" className="text-sm font-medium text-brand-700 hover:underline">← Back to POS</a>
        <div className="flex items-start gap-2">
          {hasPrinter && <PrinterActions orderId={orderId} />}
          <PrintButton label={bill.kind === "RECEIPT" ? "Print receipt" : "Print bill"} />
        </div>
      </div>
      <div className="mx-auto max-w-md rounded-lg shadow-sm print:shadow-none">
        <BillView bill={bill} />
      </div>
    </main>
  );
}
