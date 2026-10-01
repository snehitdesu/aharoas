/**
 * Tenant scoping guard — the application-layer equivalent of Postgres RLS.
 *
 * Every business row carries scalar `organizationId` (and usually `outletId`).
 * These helpers make it hard to write a query that accidentally crosses a
 * tenant boundary: callers build a `where` clause through `orgScope` /
 * `outletScope`, which always inject the caller's organization and the set of
 * outlets they are allowed to touch.
 *
 * In production on PostgreSQL, the SAME columns are enforced by RLS policies,
 * so this is defense-in-depth, not the only line of defense.
 */

export type AccessContext = {
  userId: string;
  organizationId: string;
  /** Outlet ids the actor may access. Empty array + isOrgWide=false => nothing. */
  outletIds: string[];
  /** Distinct roles the actor holds anywhere in the org. */
  roles: string[];
  /** Roles held per outlet (outletId -> roles). Org-wide roles apply everywhere. */
  outletRoles: Record<string, string[]>;
  /** Org-wide roles (from memberships with outletId = null). */
  orgRoles: string[];
  /** Owners/admins/area managers with organization-wide reach. */
  isOrgWide: boolean;
  isSuperAdmin: boolean;
};

/** where-clause fragment restricting to the caller's organization. */
export function orgScope(ctx: AccessContext): { organizationId: string } {
  return { organizationId: ctx.organizationId };
}

/**
 * where-clause fragment restricting to the caller's organization AND the
 * outlets they may access. Org-wide actors are restricted to org only.
 */
export function outletScope(ctx: AccessContext): {
  organizationId: string;
  outletId?: { in: string[] };
} {
  if (ctx.isSuperAdmin || ctx.isOrgWide) {
    return { organizationId: ctx.organizationId };
  }
  return {
    organizationId: ctx.organizationId,
    outletId: { in: ctx.outletIds },
  };
}

/** Throw if the actor may not touch the given outlet. */
export function assertOutletAccess(ctx: AccessContext, outletId: string): void {
  if (ctx.isSuperAdmin || ctx.isOrgWide) return;
  if (!ctx.outletIds.includes(outletId)) {
    throw new ForbiddenError(`No access to outlet ${outletId}`);
  }
}

/** Throw if a loaded row belongs to another organization. */
export function assertSameOrg(ctx: AccessContext, row: { organizationId: string } | null): void {
  if (!row || row.organizationId !== ctx.organizationId) {
    throw new ForbiddenError("Cross-organization access denied");
  }
}

export class ForbiddenError extends Error {
  status = 403;
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends Error {
  status = 404;
  constructor(message = "Not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

export class UnauthorizedError extends Error {
  status = 401;
  constructor(message = "Authentication required") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** 409: the request conflicts with existing state (e.g. an idempotency key reused for a different request). */
export class ConflictError extends Error {
  status = 409;
  constructor(message = "Conflict") {
    super(message);
    this.name = "ConflictError";
  }
}

export class ValidationError extends Error {
  status = 422;
  details?: unknown;
  constructor(message = "Validation failed", details?: unknown) {
    super(message);
    this.name = "ValidationError";
    this.details = details;
  }
}
