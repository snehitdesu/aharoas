/**
 * Audit logging. Append-only; normal users can never delete these rows.
 * Accepts a Prisma transaction client so an audit row is written in the SAME
 * transaction as the change it records.
 */
import type { Prisma } from "@prisma/client";
import type { AuditAction } from "@/constants/enums";
import type { AccessContext } from "@/server/db/scope";

type TxClient = Prisma.TransactionClient;

export type AuditInput = {
  action: AuditAction;
  entityType: string;
  entityId?: string;
  outletId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string;
  userAgent?: string;
};

export async function writeAudit(tx: TxClient, ctx: AccessContext, input: AuditInput): Promise<void> {
  await tx.auditLog.create({
    data: {
      organizationId: ctx.organizationId,
      outletId: input.outletId ?? null,
      actorId: ctx.userId === "system" ? null : ctx.userId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      before: input.before === undefined ? null : JSON.stringify(input.before),
      after: input.after === undefined ? null : JSON.stringify(input.after),
      ip: input.ip,
      userAgent: input.userAgent,
    },
  });
}
