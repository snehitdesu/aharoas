/**
 * Display-only estimate of order totals for the cart, following the server's
 * rule (orders.calculateOrderTotals): line net = qty × (unit + modifiers per
 * unit); the order discount is apportioned to the lines by net (paisa-rounded,
 * remainder on the largest line); tax per rate on the discounted value,
 * rounded per rate; total = net − discount + tax. A parity test pins this to
 * the server function. After placement the UI always shows the server's totals.
 */
export type EstimateLine = { qty: number; unitPrice: number; modifiersPerUnit: number; taxPct: number };

const round2 = (x: number) => Math.round((x + Math.sign(x) * Number.EPSILON) * 100) / 100;

export function estimateTotals(lines: EstimateLine[], discount = 0) {
  const nets = lines.map((l) => l.qty * (l.unitPrice + l.modifiersPerUnit));
  const subtotal = nets.reduce((a, n) => a + n, 0);
  const d = Math.min(Math.max(0, discount), subtotal);
  const shares = nets.map(() => 0);
  if (d > 0 && subtotal > 0) {
    let largest = 0;
    nets.forEach((n, i) => { if (n > nets[largest]) largest = i; });
    let given = 0;
    nets.forEach((n, i) => {
      if (i === largest) return;
      shares[i] = round2((d * n) / subtotal);
      given += shares[i];
    });
    shares[largest] = d - given;
  }
  const byRate = new Map<number, number>();
  lines.forEach((l, i) => byRate.set(l.taxPct, (byRate.get(l.taxPct) ?? 0) + Math.max(0, nets[i] - shares[i])));
  let tax = 0;
  for (const [rate, taxable] of byRate) tax += round2((taxable * rate) / 100);
  tax = round2(tax);
  return { subtotal: round2(subtotal), tax, discount: round2(d), total: round2(subtotal - d + tax) };
}
