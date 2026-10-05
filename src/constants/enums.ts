/**
 * Centralized enums / constants.
 *
 * Every Prisma `String` field that represents a status or type has its allowed
 * values defined here exactly once, as an `as const` tuple + a Zod enum + a TS
 * union type. Nothing in the app should hard-code a raw status string.
 *
 * Keep these values in sync with prisma/schema.prisma comments. When migrating
 * to PostgreSQL these tuples can back native enums without code changes.
 */
import { z } from "zod";

function makeEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return {
    values,
    zod: z.enum(values),
    is: (v: unknown): v is T[number] => typeof v === "string" && (values as readonly string[]).includes(v),
  };
}

// --- Identity / org ---
export const Role = makeEnum([
  "OWNER",
  "AREA_MANAGER",
  "ADMIN",
  "MANAGER",
  "STORE",
  "KITCHEN",
  "CAPTAIN",
  "CASHIER",
  // Finance / accounts staff: books, payables, reconciliation and reports — no POS or stock changes.
  "ACCOUNTANT",
  "CUSTOMER",
  "SUPER_ADMIN",
] as const);
export type Role = (typeof Role.values)[number];

export const DepartmentKind = makeEnum(["STORE", "KITCHEN", "BAR", "BAKERY", "PRODUCTION", "OTHER"] as const);
export type DepartmentKind = (typeof DepartmentKind.values)[number];

export const StaffStatus = makeEnum(["ACTIVE", "INACTIVE", "INVITED", "SUSPENDED"] as const);
export type StaffStatus = (typeof StaffStatus.values)[number];

// --- Master data ---
export const UnitKind = makeEnum(["WEIGHT", "VOLUME", "COUNT"] as const);
export type UnitKind = (typeof UnitKind.values)[number];

export const Station = makeEnum(["KITCHEN", "BAR", "BAKERY"] as const);
export type Station = (typeof Station.values)[number];

// --- Tables ---
export const TableStatus = makeEnum([
  "AVAILABLE",
  "OCCUPIED",
  "ORDERING",
  "PREPARING",
  "READY",
  "BILL_REQUESTED",
  "BILLED",
  "RESERVED",
  "CLEANING",
] as const);
export type TableStatus = (typeof TableStatus.values)[number];

// --- Recipes ---
export const RecipeOutputType = makeEnum(["MENU_ITEM", "SUB_RECIPE"] as const);
export type RecipeOutputType = (typeof RecipeOutputType.values)[number];

export const RecipeStatus = makeEnum(["DRAFT", "APPROVED", "ARCHIVED"] as const);
export type RecipeStatus = (typeof RecipeStatus.values)[number];

export const RecipeComponentType = makeEnum(["MATERIAL", "SUB_RECIPE"] as const);
export type RecipeComponentType = (typeof RecipeComponentType.values)[number];

// --- Orders / POS ---
export const OrderChannel = makeEnum(["DINE_IN", "TAKEAWAY", "DELIVERY", "QR", "ONLINE", "AGGREGATOR"] as const);
export type OrderChannel = (typeof OrderChannel.values)[number];

export const OrderSource = makeEnum(["POS", "QR", "ONLINE", "PETPOOJA", "MANUAL", "ZOMATO", "SWIGGY"] as const);
export type OrderSource = (typeof OrderSource.values)[number];

export const OrderStatus = makeEnum([
  "OPEN",
  "SENT",
  "PREPARING",
  "READY",
  "SERVED",
  "BILLED",
  "PAID",
  "CANCELLED",
  "REFUNDED",
] as const);
export type OrderStatus = (typeof OrderStatus.values)[number];

// --- Payments ---
export const PaymentMethod = makeEnum(["CASH", "UPI", "CARD", "WALLET", "ONLINE", "OTHER"] as const);
export type PaymentMethod = (typeof PaymentMethod.values)[number];

export const PaymentStatus = makeEnum(["PENDING", "SUCCESS", "FAILED", "REFUNDED", "PARTIAL"] as const);
export type PaymentStatus = (typeof PaymentStatus.values)[number];

// --- KOT / KDS (shared lifecycle) ---
export const KOTStatus = makeEnum(["NEW", "ACCEPTED", "PREPARING", "READY", "SERVED", "CANCELLED"] as const);
export type KOTStatus = (typeof KOTStatus.values)[number];
// KDS is the same lifecycle viewed by the kitchen.
export const KDSStatus = KOTStatus;
export type KDSStatus = KOTStatus;

// --- Inventory ---
export const InventoryTransactionType = makeEnum([
  "OPENING_BALANCE",
  "PURCHASE_RECEIPT",
  "SALE_CONSUMPTION",
  "ISSUE",
  "TRANSFER_OUT",
  "TRANSFER_IN",
  "PRODUCTION_CONSUMPTION",
  "PRODUCTION_OUTPUT",
  "WASTAGE",
  "SPOILAGE",
  "STAFF_MEAL",
  "COUNT_ADJUSTMENT",
  "RETURN",
  "OTHER_ADJUSTMENT",
] as const);
export type InventoryTransactionType = (typeof InventoryTransactionType.values)[number];

/** Which ledger types add stock (+) vs remove stock (-) by their nature. */
export const INVENTORY_INFLOW_TYPES: ReadonlySet<InventoryTransactionType> = new Set([
  "OPENING_BALANCE",
  "PURCHASE_RECEIPT",
  "TRANSFER_IN",
  "PRODUCTION_OUTPUT",
  "RETURN",
]);

export const InventorySourceType = makeEnum([
  "GRN",
  "ORDER",
  "TRANSFER",
  "ISSUE",
  "WASTAGE",
  "COUNT",
  "PRODUCTION",
  "MANUAL",
] as const);
export type InventorySourceType = (typeof InventorySourceType.values)[number];

export const WastageReason = makeEnum([
  "SPOILAGE",
  "SPILLAGE",
  "PREP_LOSS",
  "EXPIRED",
  "DAMAGED",
  "STAFF_MEAL",
  "OVERPRODUCTION",
  "OTHER",
] as const);
export type WastageReason = (typeof WastageReason.values)[number];

/** Why stock was adjusted by hand (losses of usable stock go through wastage instead). */
export const AdjustmentReason = makeEnum([
  "COUNT_CORRECTION",
  "FOUND",
  "THEFT_OR_LOSS",
  "DATA_ENTRY_ERROR",
  "RETURN_TO_VENDOR",
  "OTHER",
] as const);
export type AdjustmentReason = (typeof AdjustmentReason.values)[number];

// --- Procurement ---
export const PurchaseOrderStatus = makeEnum([
  "DRAFT",
  "SUBMITTED",
  "APPROVED",
  "ORDERED",
  "PARTIAL",
  "RECEIVED",
  "BILLED",
  "CLOSED",
  "CANCELLED",
] as const);
export type PurchaseOrderStatus = (typeof PurchaseOrderStatus.values)[number];

export const GRNStatus = makeEnum(["DRAFT", "POSTED"] as const);
export type GRNStatus = (typeof GRNStatus.values)[number];

export const PurchaseBillStatus = makeEnum(["OPEN", "PARTIAL", "PAID", "CANCELLED"] as const);
export type PurchaseBillStatus = (typeof PurchaseBillStatus.values)[number];

export const IndentStatus = makeEnum(["DRAFT", "SUBMITTED", "APPROVED", "CLOSED", "CANCELLED"] as const);
export type IndentStatus = (typeof IndentStatus.values)[number];

export const TransferStatus = makeEnum(["DRAFT", "DISPATCHED", "RECEIVED", "CANCELLED"] as const);
export type TransferStatus = (typeof TransferStatus.values)[number];

export const IssueStatus = makeEnum(["DRAFT", "ISSUED", "CANCELLED"] as const);
export type IssueStatus = (typeof IssueStatus.values)[number];

export const StockCountStatus = makeEnum(["DRAFT", "COUNTING", "REVIEW", "APPROVED", "CANCELLED"] as const);
export type StockCountStatus = (typeof StockCountStatus.values)[number];

export const ProductionStatus = makeEnum(["DRAFT", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const);
export type ProductionStatus = (typeof ProductionStatus.values)[number];

export const WastageStatus = makeEnum(["DRAFT", "POSTED", "CANCELLED"] as const);
export type WastageStatus = (typeof WastageStatus.values)[number];

// --- CRM ---
export const ReservationStatus = makeEnum(["BOOKED", "CONFIRMED", "SEATED", "COMPLETED", "CANCELLED", "NO_SHOW"] as const);
export type ReservationStatus = (typeof ReservationStatus.values)[number];

export const WaitlistStatus = makeEnum(["WAITING", "ARRIVED", "SEATED", "LEFT", "CANCELLED"] as const);
export type WaitlistStatus = (typeof WaitlistStatus.values)[number];

export const LoyaltyTxnType = makeEnum(["EARN", "REDEEM", "EXPIRE", "ADJUST"] as const);
export type LoyaltyTxnType = (typeof LoyaltyTxnType.values)[number];

// --- Finance ---
export const ReconciliationStatus = makeEnum(["DRAFT", "COMPLETED"] as const);
export type ReconciliationStatus = (typeof ReconciliationStatus.values)[number];

export const PettyCashType = makeEnum(["OPENING", "ADD", "EXPENSE", "ADJUST"] as const);
export type PettyCashType = (typeof PettyCashType.values)[number];

export const VendorPaymentMethod = makeEnum(["CASH", "BANK", "UPI", "CHEQUE"] as const);
export type VendorPaymentMethod = (typeof VendorPaymentMethod.values)[number];

// --- People ---
export const TaskStatus = makeEnum(["OPEN", "IN_PROGRESS", "DONE", "VERIFIED", "CANCELLED"] as const);
export type TaskStatus = (typeof TaskStatus.values)[number];

export const Priority = makeEnum(["LOW", "MEDIUM", "HIGH"] as const);
export type Priority = (typeof Priority.values)[number];

export const AttendanceStatus = makeEnum(["PRESENT", "LATE", "ABSENT", "LEAVE"] as const);
export type AttendanceStatus = (typeof AttendanceStatus.values)[number];

export const LeaveStatus = makeEnum(["PENDING", "APPROVED", "REJECTED"] as const);
export type LeaveStatus = (typeof LeaveStatus.values)[number];

// --- System / integrations ---
export const WebhookStatus = makeEnum(["RECEIVED", "PROCESSED", "FAILED", "DUPLICATE"] as const);
export type WebhookStatus = (typeof WebhookStatus.values)[number];

export const UnmappedSaleStatus = makeEnum(["OPEN", "MAPPED", "IGNORED"] as const);
export type UnmappedSaleStatus = (typeof UnmappedSaleStatus.values)[number];

export const AnomalyType = makeEnum([
  "NEGATIVE_STOCK",
  "COUNT_VARIANCE",
  "PRICE_SPIKE",
  "UNMAPPED_ITEM",
  "HEAVY_WASTAGE",
  "RECONCILIATION_MISMATCH",
] as const);
export type AnomalyType = (typeof AnomalyType.values)[number];

export const AnomalySeverity = makeEnum(["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const);
export type AnomalySeverity = (typeof AnomalySeverity.values)[number];

export const AnomalyStatus = makeEnum(["OPEN", "ACKNOWLEDGED", "RESOLVED", "DISMISSED"] as const);
export type AnomalyStatus = (typeof AnomalyStatus.values)[number];

export const AuditAction = makeEnum([
  "CREATE",
  "UPDATE",
  "VOID",
  "APPROVE",
  "REJECT",
  "LOGIN",
  "LOGOUT",
  "ROLE_CHANGE",
  "PAYMENT",
  "REFUND",
  "INVENTORY_MOVEMENT",
  "RECIPE_CHANGE",
  "PRICE_CHANGE",
  "STOCK_ADJUSTMENT",
  "EXPORT",
  "IMPORT",
  "BOOTSTRAP",
  "PASSWORD_LINK",
  "PASSWORD_SET",
  "PASSWORD_RESET_REQUEST",
  "PASSWORD_CHANGE",
  // background export lifecycle ("EXPORT" = export completed)
  "EXPORT_REQUESTED",
  "EXPORT_STARTED",
  "EXPORT_FAILED",
  "EXPORT_DENIED",
  "EXPORT_DOWNLOADED",
  "EXPORT_PURGED",
  // Phase 7 integrations
  "PRINT",
  "DRAWER_OPEN",
  "MESSAGE_SEND",
  "INTEGRATION_SYNC",
] as const);
export type AuditAction = (typeof AuditAction.values)[number];

export const ExportStatus = makeEnum(["PENDING", "RUNNING", "SUCCESS", "FAILED", "EXPIRED"] as const);
export type ExportStatus = (typeof ExportStatus.values)[number];

export const IntegrationKind = makeEnum(["POS", "PAYMENT", "AGGREGATOR", "SHEETS", "WHATSAPP", "EMAIL"] as const);
export type IntegrationKind = (typeof IntegrationKind.values)[number];

// ============================================================
// State-machine transition tables (enforced by services)
// ============================================================

export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  OPEN: ["SENT", "CANCELLED"],
  SENT: ["PREPARING", "READY", "SERVED", "BILLED", "CANCELLED"],
  PREPARING: ["READY", "SERVED", "CANCELLED"],
  READY: ["SERVED", "BILLED", "CANCELLED"],
  SERVED: ["BILLED", "PAID", "CANCELLED"],
  BILLED: ["PAID", "CANCELLED"],
  PAID: ["REFUNDED"],
  CANCELLED: [],
  REFUNDED: [],
};

/** Only PENDING -> RUNNING claims a job; EXPIRED = retention removed the stored file. */
export const EXPORT_TRANSITIONS: Record<ExportStatus, ExportStatus[]> = {
  PENDING: ["RUNNING"],
  RUNNING: ["SUCCESS", "FAILED"],
  SUCCESS: ["EXPIRED"],
  FAILED: [],
  EXPIRED: [],
};

export const PURCHASE_ORDER_TRANSITIONS: Record<PurchaseOrderStatus, PurchaseOrderStatus[]> = {
  DRAFT: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["APPROVED", "CANCELLED"],
  APPROVED: ["ORDERED", "CANCELLED"],
  ORDERED: ["PARTIAL", "RECEIVED", "CANCELLED"],
  // Received stock cannot be "cancelled" away: a part-received PO is short-closed.
  PARTIAL: ["RECEIVED", "CLOSED"],
  RECEIVED: ["BILLED", "CLOSED"],
  BILLED: ["CLOSED"],
  CLOSED: [],
  CANCELLED: [],
};

export const KOT_TRANSITIONS: Record<KOTStatus, KOTStatus[]> = {
  NEW: ["ACCEPTED", "CANCELLED"],
  ACCEPTED: ["PREPARING", "CANCELLED"],
  PREPARING: ["READY", "CANCELLED"],
  READY: ["SERVED"],
  SERVED: [],
  CANCELLED: [],
};

export const INDENT_TRANSITIONS: Record<IndentStatus, IndentStatus[]> = {
  DRAFT: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["APPROVED", "CANCELLED"],
  APPROVED: ["CLOSED", "CANCELLED"],
  CLOSED: [],
  CANCELLED: [],
};

export const GRN_TRANSITIONS: Record<GRNStatus, GRNStatus[]> = {
  DRAFT: ["POSTED"],
  POSTED: [],
};

export const PURCHASE_BILL_TRANSITIONS: Record<PurchaseBillStatus, PurchaseBillStatus[]> = {
  OPEN: ["PARTIAL", "PAID", "CANCELLED"],
  // -> OPEN / PARTIAL only by reversing a payment (vendorFinance.reverseVendorPayment).
  PARTIAL: ["PAID", "OPEN", "CANCELLED"],
  PAID: ["PARTIAL", "OPEN"],
  CANCELLED: [],
};

export const TRANSFER_TRANSITIONS: Record<TransferStatus, TransferStatus[]> = {
  DRAFT: ["DISPATCHED", "CANCELLED"],
  DISPATCHED: ["RECEIVED"],
  RECEIVED: [],
  CANCELLED: [],
};

export const ISSUE_TRANSITIONS: Record<IssueStatus, IssueStatus[]> = {
  DRAFT: ["ISSUED", "CANCELLED"],
  ISSUED: [],
  CANCELLED: [],
};

export const STOCK_COUNT_TRANSITIONS: Record<StockCountStatus, StockCountStatus[]> = {
  DRAFT: ["COUNTING", "CANCELLED"],
  COUNTING: ["REVIEW", "CANCELLED"],
  REVIEW: ["APPROVED", "COUNTING", "CANCELLED"],
  APPROVED: [],
  CANCELLED: [],
};

export const RESERVATION_TRANSITIONS: Record<ReservationStatus, ReservationStatus[]> = {
  BOOKED: ["CONFIRMED", "SEATED", "CANCELLED", "NO_SHOW"],
  CONFIRMED: ["SEATED", "CANCELLED", "NO_SHOW"],
  SEATED: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

export const WAITLIST_TRANSITIONS: Record<WaitlistStatus, WaitlistStatus[]> = {
  WAITING: ["ARRIVED", "SEATED", "LEFT", "CANCELLED"],
  ARRIVED: ["SEATED", "LEFT", "CANCELLED"],
  SEATED: [],
  LEFT: [],
  CANCELLED: [],
};

export const PRODUCTION_TRANSITIONS: Record<ProductionStatus, ProductionStatus[]> = {
  DRAFT: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export const WASTAGE_TRANSITIONS: Record<WastageStatus, WastageStatus[]> = {
  DRAFT: ["POSTED", "CANCELLED"],
  POSTED: [],
  CANCELLED: [],
};

export const ANOMALY_TRANSITIONS: Record<AnomalyStatus, AnomalyStatus[]> = {
  OPEN: ["ACKNOWLEDGED", "RESOLVED", "DISMISSED"],
  ACKNOWLEDGED: ["RESOLVED", "DISMISSED"],
  RESOLVED: [],
  DISMISSED: [],
};

export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  OPEN: ["IN_PROGRESS", "DONE", "CANCELLED"],
  IN_PROGRESS: ["DONE", "CANCELLED"],
  DONE: ["VERIFIED"],
  VERIFIED: [],
  CANCELLED: [],
};

/** DRAFT is approved (recipe.approve) or abandoned; APPROVED versions are retired to ARCHIVED. */
export const RECIPE_VERSION_TRANSITIONS: Record<RecipeStatus, RecipeStatus[]> = {
  DRAFT: ["APPROVED", "ARCHIVED"],
  APPROVED: ["ARCHIVED"],
  ARCHIVED: [],
};

export function canTransition<T extends string>(table: Record<T, T[]>, from: T, to: T): boolean {
  return table[from]?.includes(to) ?? false;
}
