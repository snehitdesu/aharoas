/**
 * Operator navigation. Each entry names the permission(s) the backend enforces
 * for that surface's primary read; the shell only lists entries the user holds
 * at the selected outlet (`anyOf`: at least one). This is a convenience — every
 * API still authorizes on its own. Entries marked `planned` describe surfaces
 * whose screens are not built yet; they are never shown (no links to 404s).
 */
import type { Permission } from "@/server/auth/rbac";
import type { IconName } from "@/components/ui/Icon";

export type NavSection = "Operations" | "Menu" | "Inventory" | "Purchasing" | "Master data" | "Customers" | "People" | "Finance" | "Insights" | "Admin";

export type NavItem = {
  href: string;
  label: string;
  icon: IconName;
  /** Required permission (single). */
  permission?: Permission;
  /** Alternative: any one of these permissions. */
  anyOf?: Permission[];
  section?: NavSection;
  description: string;
  /** Screen not built yet: kept for the route map, hidden from navigation. */
  planned?: true;
};

export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: "home", section: "Operations", description: "Today at this outlet" },
  { href: "/pos", label: "POS", icon: "pos", permission: "order.create", section: "Operations", description: "Take orders and payments" },
  { href: "/captain", label: "Captain (mobile)", icon: "table", permission: "order.create", section: "Operations", description: "Tables, orders and kitchen status on a phone" },
  { href: "/manager", label: "Manager (mobile)", icon: "chart", anyOf: ["reports.view", "finance.view"], section: "Operations", description: "Today, live operations, alerts and staff on a phone" },
  { href: "/kitchen", label: "Kitchen", icon: "kitchen", permission: "kot.view", section: "Operations", description: "Kitchen display (KDS)" },
  { href: "/reservations", label: "Reservations", icon: "calendar", permission: "reservation.manage", section: "Operations", description: "Bookings and waitlist" },
  { href: "/tables", label: "Floors & tables", icon: "table", anyOf: ["outlet.manage", "order.view", "reservation.manage"], section: "Operations", description: "Floor plan, table status, QR" },

  { href: "/menu", label: "Menu items", icon: "menuBook", permission: "menu.view", section: "Menu", description: "Items, variants, outlet price and availability" },
  { href: "/menu/categories", label: "Categories", icon: "tag", permission: "menu.view", section: "Menu", description: "Menu categories" },
  { href: "/menu/modifiers", label: "Modifiers", icon: "sliders", permission: "menu.view", section: "Menu", description: "Modifier groups and options" },
  { href: "/recipes", label: "Recipes", icon: "flask", permission: "recipe.view", section: "Menu", description: "Recipes, versions and costing" },

  { href: "/inventory", label: "Stock", icon: "box", permission: "inventory.view", section: "Inventory", description: "Stock on hand from the ledger" },
  { href: "/inventory/ledger", label: "Ledger", icon: "list", permission: "inventory.view", section: "Inventory", description: "Append-only stock ledger" },
  { href: "/inventory/transfers", label: "Transfers", icon: "swap", permission: "inventory.view", section: "Inventory", description: "Inter-outlet transfers" },
  { href: "/inventory/issues", label: "Issues", icon: "send", permission: "inventory.view", section: "Inventory", description: "Stock issues to departments" },
  { href: "/inventory/counts", label: "Stock counts", icon: "clipboard", permission: "inventory.view", section: "Inventory", description: "Physical counts and variance" },
  { href: "/inventory/wastage", label: "Wastage", icon: "trash", permission: "inventory.view", section: "Inventory", description: "Wastage documents" },
  { href: "/inventory/production", label: "Production", icon: "factory", permission: "inventory.view", section: "Inventory", description: "Production batches" },

  { href: "/procurement/indents", label: "Indents", icon: "note", permission: "purchase.view", section: "Purchasing", description: "Purchase requests" },
  { href: "/procurement/purchase-orders", label: "Purchase orders", icon: "cart", permission: "purchase.view", section: "Purchasing", description: "Orders to vendors" },
  { href: "/procurement/grns", label: "Goods receipts", icon: "inbox", permission: "purchase.view", section: "Purchasing", description: "GRNs (post to the ledger)" },
  { href: "/procurement/bills", label: "Purchase bills", icon: "receipt", permission: "purchase.view", section: "Purchasing", description: "Vendor bills" },
  { href: "/procurement/payments", label: "Vendor payments", icon: "cash", permission: "finance.view", section: "Purchasing", description: "Payments and vendor dues" },

  { href: "/master/materials", label: "Materials", icon: "leaf", permission: "master.view", section: "Master data", description: "Raw materials and categories" },
  { href: "/master/vendors", label: "Vendors", icon: "truck", permission: "vendor.view", section: "Master data", description: "Vendors and supplied materials" },
  { href: "/master/units", label: "Units", icon: "ruler", permission: "master.view", section: "Master data", description: "Units and conversions" },

  { href: "/customers", label: "Customers", icon: "users", permission: "customer.view", section: "Customers", description: "Guests, history and loyalty" },
  { href: "/customers/segments", label: "Segments", icon: "chart", permission: "customer.view", section: "Customers", description: "Rule-based guest segments" },
  { href: "/customers/feedback", label: "Feedback", icon: "star", permission: "customer.view", section: "Customers", description: "Guest feedback" },

  { href: "/staff", label: "Staff", icon: "user", permission: "staff.manage", section: "People", description: "Users, roles and outlet access" },
  { href: "/staff/attendance", label: "Attendance", icon: "clock", section: "People", description: "Check-in / check-out" },
  { href: "/staff/leave", label: "Leave", icon: "calendar", section: "People", description: "Leave requests" },
  { href: "/staff/tasks", label: "Tasks", icon: "check", permission: "task.view", section: "People", description: "Checklists and tasks" },

  { href: "/finance", label: "Finance overview", icon: "chart", permission: "finance.view", section: "Finance", description: "Daily closing and P&L" },
  { href: "/finance/payments", label: "Payments & refunds", icon: "card", permission: "finance.view", section: "Finance", description: "Customer payments and refunds" },
  { href: "/finance/expenses", label: "Expenses", icon: "receipt", permission: "finance.view", section: "Finance", description: "Outlet expenses" },
  { href: "/finance/petty-cash", label: "Petty cash", icon: "wallet", anyOf: ["finance.view", "finance.petty_cash"], section: "Finance", description: "Petty cash box" },
  { href: "/finance/drawer", label: "Cash drawer", icon: "cash", permission: "finance.view", section: "Finance", description: "Drawer sessions" },
  { href: "/finance/reconciliation", label: "Reconciliation", icon: "scale", permission: "finance.view", section: "Finance", description: "Daily and provider reconciliation" },

  { href: "/analytics", label: "Analytics", icon: "chart", anyOf: ["reports.view", "finance.view", "inventory.view", "purchase.view"], section: "Insights", description: "Sales, menu, stock and finance analytics with rule-based insights" },
  { href: "/reports", label: "Reports", icon: "chart", anyOf: ["reports.view", "inventory.view", "purchase.view", "finance.view", "customer.view"], section: "Insights", description: "Report center" },
  { href: "/exports", label: "Exports", icon: "download", permission: "export.run", section: "Insights", description: "Background CSV exports" },
  { href: "/anomalies", label: "Anomalies", icon: "alert", permission: "anomaly.view", section: "Insights", description: "Detected operational anomalies" },
  { href: "/notifications", label: "Notifications", icon: "bell", section: "Insights", description: "Your notifications" },

  { href: "/settings/organization", label: "Organization", icon: "building", anyOf: ["org.manage", "outlet.manage"], section: "Admin", description: "Organization profile" },
  { href: "/settings/outlets", label: "Outlets", icon: "store", anyOf: ["org.manage", "outlet.manage"], section: "Admin", description: "Outlets" },
  { href: "/settings/integrations", label: "Integrations", icon: "swap", permission: "integration.manage", section: "Admin", description: "Payment gateway, ordering platforms, messaging, accounting export" },
  { href: "/settings/printers", label: "Printers & drawer", icon: "receipt", anyOf: ["outlet.manage", "payment.take"], section: "Admin", description: "Receipt / kitchen printers and the cash drawer" },
  { href: "/settings/departments", label: "Departments", icon: "grid", permission: "master.view", section: "Admin", description: "Outlet departments" },
  { href: "/audit", label: "Audit log", icon: "shield", permission: "audit.view", section: "Admin", description: "Who changed what" },
];

export function navAllowed(item: Pick<NavItem, "permission" | "anyOf">, permissions: ReadonlySet<string>): boolean {
  if (item.permission && !permissions.has(item.permission)) return false;
  if (item.anyOf && !item.anyOf.some((p) => permissions.has(p))) return false;
  return true;
}

export function visibleNav(permissions: ReadonlySet<string>, items: NavItem[] = NAV_ITEMS): NavItem[] {
  return items.filter((i) => !i.planned && navAllowed(i, permissions));
}

/** Visible items grouped by section, in declaration order. */
export function groupNav(items: NavItem[]): Array<{ section: NavSection | null; items: NavItem[] }> {
  const groups: Array<{ section: NavSection | null; items: NavItem[] }> = [];
  for (const item of items) {
    const section = item.section ?? null;
    const g = groups.find((x) => x.section === section);
    if (g) g.items.push(item);
    else groups.push({ section, items: [item] });
  }
  return groups;
}

/** The nav entry that owns `pathname` (longest matching href). */
export function navFor(pathname: string, items: NavItem[] = NAV_ITEMS): NavItem | undefined {
  return items.filter((i) => pathname === i.href || pathname.startsWith(`${i.href}/`)).sort((a, b) => b.href.length - a.href.length)[0];
}
