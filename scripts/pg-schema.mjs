// Emit the PostgreSQL variant of prisma/schema.prisma to
// prisma/postgres/schema.prisma: provider switch + explicit DECIMAL precision.
// Usage: node scripts/pg-schema.mjs
//
// prisma/schema.prisma stays SQLite (dev, tests, desktop), where `@db.Decimal`
// is not allowed, so precision is applied here. Without it every Decimal is
// PostgreSQL's unbounded `numeric(65,30)`. The committed PostgreSQL migration
// history lives in prisma/postgres/migrations (docs/postgres.md).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Precision classes, sized from what the services write (src/domain/money.ts:
 * money() = 2 dp, qty() = 4 dp; ledger/purchase rates and POS unit prices are
 * stored unrounded) with production headroom. PostgreSQL rounds numeric input
 * half away from zero, the same as money()/qty() (ROUND_HALF_UP), and storage
 * is variable-length, so headroom costs nothing.
 */
export const DECIMAL_CLASSES = {
  // Currency amounts, ≤ 999,999,999,999.99 per row (sums are unbounded numeric).
  MONEY: [14, 2],
  // Per-base-unit costs/prices: a per-gram cost needs sub-paisa resolution.
  RATE: [16, 6],
  // Quantities in base units (qty() = 4 dp); 10^12 grams per row.
  QTY: [16, 4],
  // Percentages (tax, wastage, commission); above 999.9999 is out of range.
  PCT: [7, 4],
  // Unit conversion factors (validated ≤ 1,000,000; mg→kg needs 10^-6).
  FACTOR: [20, 10],
};

/** Every Decimal field must be classified — a new one fails generation. */
export const DECIMAL_FIELDS = {
  UnitConversion: { factor: "FACTOR" },
  Material: { taxPct: "PCT", minStock: "QTY", reorderLevel: "QTY" },
  OutletMaterialCost: { avgCost: "RATE", lastCost: "RATE" },
  Vendor: { creditLimit: "MONEY" },
  VendorMaterial: { lastRate: "RATE" },
  MenuItem: { price: "MONEY", taxPct: "PCT" },
  OutletMenuItem: { price: "MONEY" },
  MenuItemVariant: { priceDelta: "MONEY", consumptionFactor: "FACTOR" },
  ModifierOption: { priceDelta: "MONEY", materialQty: "QTY" },
  RecipeVersion: { yieldQty: "QTY", servingSize: "QTY" },
  RecipeLine: { qty: "QTY", wastagePct: "PCT" },
  Order: { subtotal: "MONEY", discount: "MONEY", tax: "MONEY", total: "MONEY" },
  // unitPrice: POS imports store the provider's unit price as sent, and
  // lineTotal = money(qty × unitPrice) must stay reproducible from the row.
  OrderItem: { qty: "QTY", unitPrice: "RATE", discount: "MONEY", taxPct: "PCT", lineTotal: "MONEY" },
  OrderItemModifier: { priceDelta: "MONEY" },
  Payment: { amount: "MONEY" },
  Refund: { amount: "MONEY" },
  KotItem: { qty: "QTY" },
  PurchaseIndentLine: { qty: "QTY" },
  PurchaseOrder: { subtotal: "MONEY", tax: "MONEY", total: "MONEY" },
  PurchaseOrderLine: { qty: "QTY", rate: "RATE", taxPct: "PCT", receivedQty: "QTY" },
  GoodsReceiptLine: { qty: "QTY", rate: "RATE", damagedQty: "QTY" },
  PurchaseBill: { subtotal: "MONEY", tax: "MONEY", total: "MONEY", paidAmount: "MONEY" },
  PurchaseBillLine: { qty: "QTY", rate: "RATE", taxPct: "PCT" },
  VendorPayment: { amount: "MONEY" },
  InventoryLedger: { qty: "QTY", rate: "RATE", amount: "MONEY" },
  InventoryTransferLine: { requestedQty: "QTY", dispatchedQty: "QTY", receivedQty: "QTY", damagedQty: "QTY" },
  InventoryIssueLine: { qty: "QTY" },
  WastageLine: { qty: "QTY", estCost: "MONEY" },
  StockCountLine: { bookQty: "QTY", physicalQty: "QTY", variance: "QTY", costImpact: "MONEY" },
  ProductionBatch: { plannedQty: "QTY", actualQty: "QTY" },
  ProductionLine: { qty: "QTY" },
  Expense: { amount: "MONEY" },
  PettyCashTxn: { amount: "MONEY" },
  CashDrawerSession: { openingFloat: "MONEY", closingCount: "MONEY", expectedCash: "MONEY", variance: "MONEY" },
  CashDrawerMovement: { amount: "MONEY" },
  TaxInvoice: { taxableValue: "MONEY", cgst: "MONEY", sgst: "MONEY", igst: "MONEY", totalTax: "MONEY", total: "MONEY" },
  TaxInvoiceLine: { ratePct: "PCT", taxableValue: "MONEY", cgst: "MONEY", sgst: "MONEY", igst: "MONEY" },
  ReconciliationLine: { expected: "MONEY", actual: "MONEY", difference: "MONEY" },
  Aggregator: { commissionPct: "PCT" },
  AggregatorOrder: { grossAmount: "MONEY", discount: "MONEY", commission: "MONEY", tax: "MONEY", platformFee: "MONEY", netPayout: "MONEY" },
  AggregatorSettlement: { expectedPayout: "MONEY", actualPayout: "MONEY", difference: "MONEY" },
  UnmappedSale: { qty: "QTY" },
};

/** SQLite schema source → PostgreSQL schema source. Throws on any unclassified Decimal. */
export function toPostgresSchema(src) {
  const pg = src.replace(/provider\s*=\s*"sqlite"/, 'provider = "postgresql"');
  if (pg === src) throw new Error("sqlite provider line not found");
  let model = null;
  const seen = new Set();
  const out = pg.split(/\r?\n/).map((line) => {
    const m = /^model (\w+) \{/.exec(line);
    if (m) model = m[1];
    else if (/^\}/.test(line)) model = null;
    const f = model && /^(\s+)(\w+)(\s+)(Decimal\??)(?=\s|$)/.exec(line);
    if (!f) return line;
    if (line.includes("@db.")) throw new Error(`${model}.${f[2]} already has a native type`);
    const cls = DECIMAL_FIELDS[model]?.[f[2]];
    if (!cls) throw new Error(`Unclassified Decimal field ${model}.${f[2]}: add it to DECIMAL_FIELDS in scripts/pg-schema.mjs`);
    seen.add(`${model}.${f[2]}`);
    const [p, s] = DECIMAL_CLASSES[cls];
    return line.replace(f[0], `${f[0]} @db.Decimal(${p}, ${s})`);
  });
  for (const [m, fields] of Object.entries(DECIMAL_FIELDS))
    for (const name of Object.keys(fields))
      if (!seen.has(`${m}.${name}`)) throw new Error(`DECIMAL_FIELDS lists ${m}.${name}, which is not a Decimal field in the schema`);
  return "// GENERATED by scripts/pg-schema.mjs from prisma/schema.prisma — do not edit.\n" + out.join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  mkdirSync("prisma/postgres", { recursive: true });
  writeFileSync("prisma/postgres/schema.prisma", toPostgresSchema(readFileSync("prisma/schema.prisma", "utf8")));
  console.log("wrote prisma/postgres/schema.prisma");
}
