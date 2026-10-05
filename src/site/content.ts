/**
 * Product content for the public website. Every capability listed here exists
 * in RESTORA 1.0 (see docs/release-notes.md, docs/phase*-*.md); limits are
 * stated where they matter. Do not add a feature here before it ships.
 */
import type { ScreenName } from "./screens";

export type ModuleSlug = "pos" | "qr-ordering" | "kitchen" | "inventory" | "procurement" | "finance" | "analytics" | "staff" | "integrations";

export type Module = {
  slug: ModuleSlug;
  name: string;
  /** One-line summary for indexes. */
  summary: string;
  headline: string;
  lead: string;
  layout: "wide" | "split" | "phones" | "dark";
  screens: ScreenName[];
  workflow?: { title: string; steps: { name: string; body: string }[] };
  capabilities: { title: string; body: string }[];
  note?: string;
  related: ModuleSlug[];
  metaDescription: string;
};

export const MODULES: Module[] = [
  {
    slug: "pos",
    name: "POS",
    summary: "Tables, orders, rounds, payments and bills.",
    headline: "Your restaurant floor. In one view.",
    lead: "Pick a table, see what is running, add a round and send it to the kitchen. Dine-in, takeaway and delivery orders from the same screen, with payments and bills at the end.",
    layout: "wide",
    screens: ["pos", "pos-floor", "captain"],
    workflow: {
      title: "An order at the POS",
      steps: [
        { name: "Choose a table", body: "Floors and tables show free or occupied. An occupied table opens its running order." },
        { name: "Build the order", body: "Menu by category with search, veg marks, variants and modifiers, covers and the customer." },
        { name: "Send to kitchen", body: "Each round becomes kitchen tickets for the right stations, printed automatically when a printer is set up." },
        { name: "Take payment", body: "Cash, UPI, card or online. Split the bill or take part payments, then print the bill or receipt." },
      ],
    },
    capabilities: [
      { title: "Dine-in, takeaway, delivery", body: "One POS for every order type, with tables and covers for dine-in." },
      { title: "Variants and modifiers", body: "Required and optional modifier groups with price changes, checked by the server." },
      { title: "Rounds", body: "Add items to a running order and fire only the new ones to the kitchen." },
      { title: "Discounts", body: "Order discounts apportioned across lines so tax stays correct." },
      { title: "Split and partial payments", body: "Several payments against one bill, in any mix of methods." },
      { title: "Refunds and voids", body: "Need a manager's fresh password confirmation, and are written to the audit log." },
      { title: "Safe retries", body: "Orders and payments carry idempotency keys, so a retry on a bad connection never double-charges." },
      { title: "Bills and receipts", body: "Printable bills, and GST-ready invoices issued from the order." },
    ],
    related: ["kitchen", "qr-ordering", "finance"],
    metaDescription: "RESTORA POS: restaurant billing with tables, rounds, modifiers, split payments, refunds and KOT printing.",
  },
  {
    slug: "qr-ordering",
    name: "QR ordering",
    summary: "Guests order from a table QR code.",
    headline: "Turn every table into an ordering point.",
    lead: "Each table gets its own QR code. Guests open the live menu on their phone, build a cart and place the order. It arrives in the same order engine as the POS, so the kitchen, the bill and the stock all see it.",
    layout: "phones",
    screens: ["guest-menu", "guest-cart"],
    workflow: {
      title: "From scan to kitchen",
      steps: [
        { name: "Scan", body: "The table's QR code opens the menu for that outlet and table. No app, no sign-in." },
        { name: "Menu", body: "Categories, search, veg marks and modifiers, with the prices set in RESTORA." },
        { name: "Cart", body: "Guests review the cart and place the order." },
        { name: "Order", body: "Staff accept it, or the guest pays online first through the payment gateway. Then it goes to the kitchen like any other order." },
        { name: "Track", body: "The guest follows the order status on their phone." },
      ],
    },
    capabilities: [
      { title: "One engine", body: "QR orders are ordinary RESTORA orders: KOTs, bills, payments, stock and analytics all apply." },
      { title: "Several orders per table", body: "Different guests at one table can order separately; the table is freed when the last order closes." },
      { title: "Prepaid online payment", body: "Optional pay-before-order through the configured payment gateway, confirmed by signed webhooks." },
      { title: "Staff acceptance", body: "Unpaid QR orders wait for staff to accept them before the kitchen sees them." },
    ],
    note: "Online payment needs a payment gateway account. The Razorpay adapter is built and contract-tested; it has not yet run against a live Razorpay account.",
    related: ["pos", "kitchen", "integrations"],
    metaDescription: "RESTORA QR ordering: guests scan a table QR, order from the live menu and optionally pay online. Orders flow to the kitchen and POS.",
  },
  {
    slug: "kitchen",
    name: "Kitchen",
    summary: "KOT per station and a kitchen display.",
    headline: "From order to kitchen, without the chaos.",
    lead: "Every round becomes a kitchen order ticket for each station that prepares it. The kitchen display shows tickets as new, in progress and ready, and the floor sees each change.",
    layout: "dark",
    screens: ["kitchen", "captain"],
    workflow: {
      title: "A ticket's life",
      steps: [
        { name: "KOT", body: "Sending an order creates one KOT per station: kitchen, bakery, bar, or the stations you define." },
        { name: "Accept", body: "The station accepts the ticket on the kitchen display. Tickets show table, covers, order and elapsed minutes." },
        { name: "Preparing", body: "Cooks start the ticket when they begin cooking." },
        { name: "Ready", body: "Ready tickets show on the captain app's table board, so food is picked up on time." },
        { name: "Served", body: "The ticket leaves the display. Voided items are recorded, not erased." },
      ],
    },
    capabilities: [
      { title: "Stations", body: "Items route to the station that prepares them. Filter the display by station." },
      { title: "Automatic KOT printing", body: "Print tickets to a network ESC/POS printer per station, with retries when a printer is offline." },
      { title: "Elapsed time", body: "Each ticket shows how long it has been waiting." },
      { title: "Live updates", body: "The display refreshes on its own every few seconds; the interval is adjustable on screen." },
    ],
    related: ["pos", "qr-ordering", "staff"],
    metaDescription: "RESTORA kitchen: KOTs per station and a kitchen display system (KDS) with accept, preparing, ready and served states.",
  },
  {
    slug: "inventory",
    name: "Inventory",
    summary: "Stock, recipes, consumption and wastage.",
    headline: "Know what you have. Know what you use.",
    lead: "Recipes connect the menu to the store. When an order is settled, RESTORA consumes its ingredients, records the movement in the ledger and keeps the stock value at weighted average cost.",
    layout: "split",
    screens: ["inventory", "recipes", "ledger"],
    workflow: {
      title: "How stock moves",
      steps: [
        { name: "Receive", body: "Goods received against a purchase order add stock at the price paid." },
        { name: "Produce", body: "Production batches turn raw materials into prepared items, such as gravies and pastes." },
        { name: "Consume", body: "Each settled sale draws down ingredients through its approved recipe, including sub-recipes." },
        { name: "Count", body: "Stock counts compare what is on the shelf with the ledger and post the variance." },
      ],
    },
    capabilities: [
      { title: "Materials and units", body: "Materials with SKUs, units and conversions, reorder levels and low-stock status." },
      { title: "Recipes with versions", body: "Recipes and sub-recipes are versioned and approved before they drive consumption, with plate costing." },
      { title: "Append-only ledger", body: "Every receipt, issue, transfer, wastage, production and adjustment is a ledger row. Nothing is edited in place." },
      { title: "Wastage", body: "Record wastage with a reason; heavy wastage raises an anomaly." },
      { title: "Transfers and issues", body: "Move stock between outlets and issue it to departments." },
      { title: "Unmapped sales", body: "Items sold without a recipe are queued for mapping, so missing consumption is visible." },
    ],
    related: ["procurement", "analytics", "pos"],
    metaDescription: "RESTORA inventory: recipe-based consumption, versioned recipes, stock counts, wastage, transfers and an append-only stock ledger.",
  },
  {
    slug: "procurement",
    name: "Procurement",
    summary: "Indent, purchase order, GRN, bill, payment.",
    headline: "From purchase request to vendor payment.",
    lead: "Buying follows one documented path. Each step creates the next, receipts update stock, and what you owe each vendor is always one screen away.",
    layout: "wide",
    screens: ["procurement-po", "procurement-payments"],
    workflow: {
      title: "The procurement path",
      steps: [
        { name: "Indent", body: "A department asks for materials." },
        { name: "Purchase order", body: "The indent becomes a purchase order to a vendor." },
        { name: "GRN", body: "Goods received are checked against the order and posted to stock." },
        { name: "Bill", body: "The vendor's bill is recorded against what was received." },
        { name: "Vendor payment", body: "Payments settle bills; dues and aging show what is outstanding and overdue." },
      ],
    },
    capabilities: [
      { title: "Vendors", body: "Vendor records with the materials each one supplies." },
      { title: "Dues and aging", body: "Outstanding and overdue amounts per vendor." },
      { title: "Price checks", body: "Unusual price changes on receipts raise an anomaly." },
      { title: "Documented trail", body: "Every document links to the one before it." },
    ],
    related: ["inventory", "finance", "analytics"],
    metaDescription: "RESTORA procurement: indents, purchase orders, goods receipts (GRN), vendor bills, vendor payments, dues and aging.",
  },
  {
    slug: "finance",
    name: "Finance",
    summary: "Invoices, payments, expenses, cash and closing.",
    headline: "From every payment to every rupee.",
    lead: "Payments, refunds, invoices, expenses and cash all land in one place. Close the day with expected against counted cash, and read profit and loss for any period.",
    layout: "split",
    screens: ["finance", "manager"],
    capabilities: [
      { title: "GST-ready invoices", body: "Invoices and credit notes numbered without gaps for each financial year, with tax per line." },
      { title: "Payments and refunds", body: "Every payment and refund by method, with gateway reconciliation." },
      { title: "Expenses and petty cash", body: "Record expenses by category and keep petty cash balanced." },
      { title: "Cash drawer", body: "Drawer sessions with float, expected cash, counted cash and variance." },
      { title: "Daily closing", body: "Reconcile the day and close it once open orders and drawers are settled." },
      { title: "Profit and loss", body: "Net sales, gross margin, expenses and net profit for a date range." },
      { title: "Vendor dues", body: "What the restaurant owes, from procurement bills and payments." },
      { title: "Accounting export", body: "Export vouchers as CSV or Tally XML for your accountant." },
    ],
    note: "RESTORA produces GST-ready records. It is not a certified GST invoicing system: there is no e-invoicing (IRN or signed QR) and no GSTR filing. Have your accountant review your setup.",
    related: ["analytics", "procurement", "pos"],
    metaDescription: "RESTORA finance: GST-ready invoices and credit notes, payments, expenses, petty cash, cash drawer, daily closing and profit and loss.",
  },
  {
    slug: "analytics",
    name: "Analytics",
    summary: "Sales, menu, inventory and finance.",
    headline: "Understand your restaurant.",
    lead: "Analytics read the orders, payments and stock movements RESTORA already records. No spreadsheets, no re-entry, and the same numbers everywhere.",
    layout: "wide",
    screens: ["analytics-menu", "analytics-sales", "dashboard"],
    capabilities: [
      { title: "What is selling?", body: "Best sellers by quantity and revenue, by category and by day." },
      { title: "What is moving slowly?", body: "Slow sellers and items with no sales in the period." },
      { title: "What is being wasted?", body: "Wastage by material and reason, and its value." },
      { title: "What are sales doing?", body: "Net sales, orders, average order value, discounts and refunds over time." },
      { title: "What are expenses doing?", body: "Expenses by category against sales, in the profit and loss." },
      { title: "What do we owe vendors?", body: "Vendor dues and overdue amounts from procurement." },
    ],
    note: "Reports cover sales, menu, inventory, procurement and finance, with CSV downloads and background exports for large ranges.",
    related: ["finance", "inventory", "staff"],
    metaDescription: "RESTORA analytics and reports: sales trends, best and slow sellers, wastage, expenses, vendor dues and CSV exports.",
  },
  {
    slug: "staff",
    name: "Staff and roles",
    summary: "One system, a screen for every role.",
    headline: "One system. Every role.",
    lead: "Owners, managers, cashiers, captains and the kitchen each get the screen for their job, and only the permissions their role needs, per outlet.",
    layout: "split",
    screens: ["staff", "captain", "manager"],
    capabilities: [
      { title: "Roles per outlet", body: "Owner, manager, cashier, captain, kitchen and store roles, scoped to the outlets each person works at." },
      { title: "Captain app", body: "A phone-first table board for taking rounds and requesting bills." },
      { title: "Manager app", body: "The live day on a phone: sales, open orders, payments, alerts and staff." },
      { title: "Attendance, leave and tasks", body: "Shifts, attendance, leave requests and tasks for the team." },
      { title: "Step-up confirmation", body: "Refunds, voids, settings and restores need a fresh password confirmation." },
      { title: "Audit log", body: "Sensitive changes are recorded with who, what and when." },
    ],
    related: ["pos", "kitchen", "analytics"],
    metaDescription: "RESTORA staff management: role-based access per outlet, captain and manager phone apps, attendance, leave, tasks and an audit log.",
  },
  {
    slug: "integrations",
    name: "Integrations",
    summary: "Payments, printers, messaging, accounting.",
    headline: "Connect RESTORA to the tools around your restaurant.",
    lead: "RESTORA connects to payment gateways, kitchen and receipt printers, customer messaging and accounting. Each connection is labelled with its real status.",
    layout: "split",
    screens: ["integrations", "printers"],
    capabilities: [
      { title: "Status you can trust", body: "Every connection runs in LIVE, SANDBOX or MOCK mode, shown in Settings. Mock providers are refused in production." },
      { title: "Signed webhooks", body: "Incoming events are verified by signature, bound to your account and de-duplicated." },
      { title: "Encrypted secrets", body: "API keys are stored encrypted, per restaurant, never in the browser." },
    ],
    related: ["finance", "kitchen", "qr-ordering"],
    metaDescription: "RESTORA integrations: Razorpay payments, ESC/POS receipt and KOT printers, cash drawer, Twilio SMS and WhatsApp, Tally XML and CSV accounting export.",
  },
];

export const moduleBySlug = (slug: string) => MODULES.find((m) => m.slug === slug);

export type IntegrationStatus = "live" | "sandbox" | "mock" | "planned";
export const STATUS_LABEL: Record<IntegrationStatus, string> = { live: "Live", sandbox: "Sandbox", mock: "Mock", planned: "Coming later" };

/** The real integration catalogue (docs/phase7-integrations.md, section 3). */
export const INTEGRATIONS: { name: string; kind: string; status: IntegrationStatus[]; detail: string }[] = [
  { name: "Network ESC/POS printers", kind: "Receipts and KOT", status: ["live"], detail: "Raw ESC/POS over the network: receipts, KOTs per station and paper cut. Verified against a real TCP endpoint; not yet on every printer model." },
  { name: "Cash drawer", kind: "Hardware", status: ["live"], detail: "Opened by the receipt printer's drawer kick." },
  { name: "Accounting export", kind: "Accounting", status: ["live"], detail: "Vouchers as CSV or Tally XML files. No live sync with accounting software yet." },
  { name: "Razorpay", kind: "Payment gateway", status: ["sandbox", "live"], detail: "Online payments and refunds with signed webhooks. Contract-tested; not yet run against a live Razorpay account." },
  { name: "Twilio SMS and WhatsApp", kind: "Customer messaging", status: ["sandbox", "live"], detail: "Order confirmed, order ready and payment received messages, with delivery status. Contract-tested; not yet run against a live Twilio account." },
  { name: "Swiggy and Zomato", kind: "Food aggregators", status: ["mock"], detail: "Order intake, cancellations and status updates work with mock adapters. Live connections need partner API access." },
  { name: "Petpooja", kind: "POS import", status: ["planned"], detail: "Not available yet." },
  { name: "Tally, Zoho Books, QuickBooks sync", kind: "Accounting", status: ["planned"], detail: "Live API sync is not available yet; use the file export." },
];

/** Restaurant types RESTORA 1.0 genuinely supports, and how. */
export const SOLUTIONS: { name: string; body: string; uses: string[]; modules: ModuleSlug[]; limit?: string }[] = [
  {
    name: "Full-service restaurants",
    body: "Floors and tables, captains taking rounds at the table, a kitchen that sees every round, and bills at the end.",
    uses: ["Floors, tables and covers", "Captain app for rounds", "KOT per station and kitchen display", "Reservations and waitlist", "Split bills"],
    modules: ["pos", "kitchen", "staff"],
  },
  {
    name: "Cafés and quick service",
    body: "Fast counter orders for takeaway, and QR ordering at the table with optional payment before the order is placed.",
    uses: ["Takeaway orders at the POS", "QR ordering with optional prepayment", "Bar or counter stations", "UPI, card and cash"],
    modules: ["pos", "qr-ordering", "kitchen"],
  },
  {
    name: "Delivery and takeaway kitchens",
    body: "Delivery and takeaway orders at the POS, with recipe costing and stock control behind them.",
    uses: ["Delivery and takeaway order types", "Recipe costing", "Stock and wastage control"],
    modules: ["pos", "inventory", "analytics"],
    limit: "Swiggy and Zomato connections run on mock adapters today; live aggregator order intake needs partner API access.",
  },
  {
    name: "Restaurants with a prep or central kitchen",
    body: "Production batches for gravies, pastes and bases, issues to departments, and transfers between outlets.",
    uses: ["Production batches", "Sub-recipes", "Issues to departments", "Transfers between outlets"],
    modules: ["inventory", "procurement"],
  },
  {
    name: "One business, several outlets",
    body: "Run several outlets of one restaurant business from one account, with outlet switching, transfers and outlet comparison.",
    uses: ["Outlet switcher", "Roles per outlet", "Outlet comparison in analytics", "Stock transfers"],
    modules: ["staff", "analytics", "inventory"],
    limit: "Separate restaurant businesses in one account (multi-restaurant groups) are not supported yet.",
  },
];
