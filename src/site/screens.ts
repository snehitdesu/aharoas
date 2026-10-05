/**
 * Catalogue of the product screenshots in public/site/screens. Each one is the
 * real application captured with sample data (scripts/site/capture-screens.mjs,
 * which also records each image's pixel size in screens-meta.json); alt text
 * describes what the screen shows, not marketing copy.
 */
import meta from "./screens-meta.json";

const desktop = (title: string, alt: string) => ({ device: "desktop" as const, title, alt });
const phone = (title: string, alt: string) => ({ device: "phone" as const, title, alt });

const defs = {
  dashboard: desktop("Dashboard", "RESTORA dashboard for one outlet: net sales today, open orders, kitchen tickets, reservations, open tables, low stock and open anomalies."),
  pos: desktop("POS", "RESTORA POS: menu grid by category on the left, a dine-in order for table F2 on the right with quantities, tax, total, Send to kitchen and Send and pay."),
  "pos-tables": desktop("POS", "Choose table dialog in RESTORA POS showing first and ground floor tables, each marked free or occupied with seat count."),
  "pos-floor": desktop("POS · Choose table", "RESTORA POS floor plan: first floor and ground floor tables, each marked free or occupied with its seat count. Occupied tables open their running order."),
  kitchen: desktop("Kitchen display", "RESTORA kitchen display with New, In progress and Ready columns of KOTs, each with table, station, items, elapsed time and the next action."),
  tables: desktop("Floors and tables", "Floors and tables management screen in RESTORA."),
  inventory: desktop("Stock on hand", "Stock on hand: materials with quantity, reorder level, status, weighted average cost and value, plus total stock value."),
  ledger: desktop("Inventory ledger", "Append-only inventory ledger listing every stock movement with type, quantity and cost."),
  wastage: desktop("Wastage", "Wastage records with reason, quantity and value."),
  recipes: desktop("Recipes", "Versioned recipes and sub-recipes with approval status, linked to the menu items they produce."),
  "procurement-po": desktop("Purchase orders", "Purchase orders by vendor with status, goods receipt count and total."),
  "procurement-grn": desktop("Goods receipts", "Goods receipt notes recorded against purchase orders."),
  "procurement-bills": desktop("Vendor bills", "Vendor bills with amounts billed, paid and due."),
  "procurement-payments": desktop("Vendor payments", "Vendor payments: outstanding and overdue totals, dues per vendor and the payments made."),
  finance: desktop("Finance", "Finance overview: daily closing checks, expected collections by payment method and profit and loss for a date range."),
  "finance-drawer": desktop("Cash drawer", "Cash drawer sessions with float, expected and counted cash and variance."),
  "finance-expenses": desktop("Expenses", "Expenses recorded by category."),
  analytics: desktop("Analytics", "Analytics insights for an outlet."),
  "analytics-sales": desktop("Analytics", "Sales analytics: net sales, orders, gross sales and refunds, a daily sales trend and payment methods."),
  "analytics-menu": desktop("Analytics", "Menu analytics: best sellers and slow sellers with quantity, gross, discount and refunds."),
  reports: desktop("Reports", "Reports library with CSV and background exports."),
  staff: desktop("Team", "Team screen: staff with roles per outlet, last sign-in, status and access controls."),
  integrations: desktop("Integrations", "Integrations settings: connections with provider, mode and status."),
  printers: desktop("Printers", "Receipt and KOT printer settings."),
  captain: phone("Captain", "Captain app on a phone: table board with free and occupied tables, running totals and kitchen status."),
  manager: phone("Manager", "Manager app on a phone: today's net sales, orders, discounts, refunds, outstanding amount and payments by method."),
  "guest-menu": phone("Guest menu", "Guest menu opened from a table QR code: categories, dishes with veg and non-veg marks, prices and Add buttons."),
  "guest-cart": phone("Guest menu", "Guest menu with three dishes added and a View cart bar showing the item count and total."),
} as const;

export type ScreenName = keyof typeof defs;
type Def = (typeof defs)[ScreenName];
const sizes = meta as Record<string, { w: number; h: number }>;

export const SCREENS = Object.fromEntries(
  Object.entries(defs).map(([k, v]) => [k, { ...v, src: `/site/screens/${k}.webp`, w: sizes[k]?.w ?? 2880, h: sizes[k]?.h ?? 1800 }]),
) as Record<ScreenName, Def & { src: string; w: number; h: number }>;
