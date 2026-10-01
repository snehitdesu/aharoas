/**
 * Centralized role-based access control.
 *
 * The permission matrix is the single source of truth for "what can each role
 * do". Services call `assertCan(ctx, permission, outletId?)` before any state
 * change. Never rely on the frontend hiding a route/button.
 */
import type { Role } from "@/constants/enums";
import { type AccessContext, ForbiddenError } from "@/server/db/scope";

// Granular permissions. Add here, then grant to roles in ROLE_PERMISSIONS.
export const PERMISSIONS = [
  // org / outlet / staff
  "org.manage",
  "outlet.manage",
  "staff.manage",
  "role.manage",
  // master data
  "master.view",
  "master.manage",
  // vendors + procurement
  "vendor.view",
  "vendor.manage",
  "purchase.view",
  "purchase.create",
  "purchase.approve",
  "grn.create",
  "bill.manage",
  "vendor.pay",
  // inventory
  "inventory.view",
  "inventory.issue",
  "inventory.transfer",
  "inventory.count",
  "inventory.wastage",
  "inventory.produce",
  "inventory.adjust",
  "inventory.approve_adjustment",
  // recipes / menu
  "recipe.view",
  "recipe.manage",
  "recipe.approve",
  "menu.view",
  "menu.manage",
  // pos / orders
  "order.view",
  "order.create",
  "order.modify",
  "order.cancel",
  "order.discount",
  "payment.take",
  "payment.refund",
  // kitchen
  "kot.view",
  "kot.update",
  // finance
  "finance.view",
  "finance.reconcile",
  "finance.petty_cash",
  "expense.manage",
  // crm
  "customer.view",
  "customer.manage",
  "loyalty.manage",
  "reservation.manage",
  // analytics / ops
  "reports.view",
  "anomaly.view",
  "anomaly.resolve",
  "task.view",
  "task.manage",
  "audit.view",
  "integration.manage",
  "export.run",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL: Permission[] = [...PERMISSIONS];

// Role -> permissions. "*" via ALL for top roles.
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  SUPER_ADMIN: ALL,
  OWNER: ALL,
  AREA_MANAGER: ALL.filter((p) => p !== "org.manage" && p !== "role.manage"),
  ADMIN: ALL.filter((p) => p !== "org.manage"),
  MANAGER: [
    "outlet.manage",
    "staff.manage",
    "master.view",
    "master.manage",
    "vendor.view",
    "vendor.manage",
    "purchase.view",
    "purchase.create",
    "purchase.approve",
    "grn.create",
    "bill.manage",
    "vendor.pay",
    "inventory.view",
    "inventory.issue",
    "inventory.transfer",
    "inventory.count",
    "inventory.wastage",
    "inventory.produce",
    "inventory.adjust",
    "inventory.approve_adjustment",
    "recipe.view",
    "recipe.manage",
    "recipe.approve",
    "menu.view",
    "menu.manage",
    "order.view",
    "order.create",
    "order.modify",
    "order.cancel",
    "order.discount",
    "payment.take",
    "payment.refund",
    "kot.view",
    "kot.update",
    "finance.view",
    "finance.reconcile",
    "finance.petty_cash",
    "expense.manage",
    "customer.view",
    "customer.manage",
    "loyalty.manage",
    "reservation.manage",
    "reports.view",
    "anomaly.view",
    "anomaly.resolve",
    "task.view",
    "task.manage",
    "export.run",
  ],
  STORE: [
    "master.view",
    "vendor.view",
    "purchase.view",
    "purchase.create",
    "grn.create",
    "inventory.view",
    "inventory.issue",
    "inventory.transfer",
    "inventory.count",
    "inventory.wastage",
    "inventory.produce",
    "inventory.adjust",
    "recipe.view",
    "task.view",
  ],
  KITCHEN: ["recipe.view", "menu.view", "kot.view", "kot.update", "order.view", "inventory.view", "task.view"],
  CAPTAIN: ["menu.view", "order.view", "order.create", "order.modify", "kot.view", "customer.view", "reservation.manage"],
  CASHIER: [
    "menu.view",
    "order.view",
    "order.create",
    "order.modify",
    "order.discount",
    "payment.take",
    "customer.view",
    "customer.manage",
    "finance.view",
  ],
  CUSTOMER: [],
};

/** Compute the union of permissions for a set of roles. */
export function permissionsForRoles(roles: string[]): Set<Permission> {
  const set = new Set<Permission>();
  for (const r of roles) {
    const perms = ROLE_PERMISSIONS[r as Role];
    if (perms) for (const p of perms) set.add(p);
  }
  return set;
}

/**
 * Does the actor have `permission`? If `outletId` is given, the permission must
 * come from a role held at that outlet (or an org-wide role). Super admins and
 * org-wide actors are checked against their global role set.
 */
export function can(ctx: AccessContext, permission: Permission, outletId?: string): boolean {
  if (ctx.isSuperAdmin) return true;

  // Roles that apply for this check.
  let roles: string[];
  if (!outletId || ctx.isOrgWide) {
    roles = ctx.roles;
  } else {
    // outlet-specific: org-wide roles + roles at that outlet
    roles = [...ctx.orgRoles, ...(ctx.outletRoles[outletId] ?? [])];
    // Must actually have access to the outlet at all.
    if (!ctx.outletIds.includes(outletId)) return false;
  }
  return permissionsForRoles(roles).has(permission);
}

/** Throw ForbiddenError unless the actor has the permission. */
export function assertCan(ctx: AccessContext, permission: Permission, outletId?: string): void {
  if (!can(ctx, permission, outletId)) {
    throw new ForbiddenError(
      `Missing permission "${permission}"${outletId ? ` for outlet ${outletId}` : ""}`
    );
  }
}
