/**
 * Display-only estimate of order totals for the cart, following the server's
 * rule (orders.calculateOrderTotals): line = qty × (unit + modifiers per unit),
 * tax charged per line on its net, order discount off the subtotal, rounding to
 * 2 dp half-up at the end. A parity test pins this to the server function.
 * After placement the UI always shows the server's totals instead.
 */
export type EstimateLine = { qty: number; unitPrice: number; modifiersPerUnit: number; taxPct: number };

const round2 = (x: number) => Math.round((x + Math.sign(x) * Number.EPSILON) * 100) / 100;

export function estimateTotals(lines: EstimateLine[], discount = 0) {
  let subtotal = 0;
  let tax = 0;
  for (const l of lines) {
    const net = l.qty * (l.unitPrice + l.modifiersPerUnit);
    subtotal += net;
    tax += (net * l.taxPct) / 100;
  }
  const d = Math.min(Math.max(0, discount), subtotal);
  return { subtotal: round2(subtotal), tax: round2(tax), discount: round2(d), total: round2(subtotal - d + tax) };
}
