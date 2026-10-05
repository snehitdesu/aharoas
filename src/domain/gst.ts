/**
 * GST primitives (pure). These are the building blocks of GST-READY data —
 * validated GSTINs, state codes, the Indian financial year, and the
 * CGST/SGST/IGST split of a tax amount. They do not by themselves make a
 * document a compliant GST tax invoice (see docs/phase4-finance.md).
 */
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { D, money, type Decimalish } from "@/domain/money";

const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** GST state / UT codes (01–38) and 97 (other territory). */
const STATE_CODES = new Set([...Array.from({ length: 38 }, (_, i) => String(i + 1).padStart(2, "0")), "97"]);

/** The GSTIN check character (mod-36 weighted sum over the first 14 characters). */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(first14[i]) * ((i % 2) + 1);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36];
}

export type GstinCheck = { valid: true; gstin: string; stateCode: string; pan: string } | { valid: false; reason: string };

/** Structure (state code, PAN, entity, "Z", check character) and checksum. */
export function validateGstin(raw: string): GstinCheck {
  const g = (raw ?? "").trim().toUpperCase();
  if (!FORMAT.test(g)) return { valid: false, reason: "GSTIN must be 15 characters: 2-digit state code, PAN, entity number, Z, check character" };
  if (!STATE_CODES.has(g.slice(0, 2))) return { valid: false, reason: `Unknown GST state code ${g.slice(0, 2)}` };
  if (gstinCheckChar(g.slice(0, 14)) !== g[14]) return { valid: false, reason: "GSTIN check character does not match" };
  return { valid: true, gstin: g, stateCode: g.slice(0, 2), pan: g.slice(2, 12) };
}

/** Indian financial year (1 April – 31 March) of a calendar date "YYYY-MM-DD": "2026-27". */
export function fiscalYearOf(isoDay: string): string {
  const [y, m] = isoDay.split("-").map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export type SupplyType = "INTRA" | "INTER" | "UNREGISTERED";

/**
 * Supply type: no seller GSTIN -> UNREGISTERED (no GST charged as GST);
 * place of supply in the seller's state -> INTRA (CGST + SGST); else INTER (IGST).
 * For restaurant service the place of supply is the restaurant's location, so
 * the default is INTRA; INTER arises only when a different place of supply is
 * recorded explicitly.
 */
export function supplyTypeOf(sellerStateCode: string | null, placeOfSupply: string | null): SupplyType {
  if (!sellerStateCode) return "UNREGISTERED";
  return !placeOfSupply || placeOfSupply === sellerStateCode ? "INTRA" : "INTER";
}

export type TaxSplit = { cgst: Prisma.Decimal; sgst: Prisma.Decimal; igst: Prisma.Decimal };

/**
 * Split an already-rounded tax amount. INTRA: CGST = half rounded to the paisa,
 * SGST = the rest (so CGST + SGST = tax exactly, the odd paisa on SGST).
 * INTER: all IGST. UNREGISTERED: nothing is GST.
 */
export function splitTax(tax: Decimalish, type: SupplyType): TaxSplit {
  const t = money(tax);
  if (type === "INTER") return { cgst: D(0), sgst: D(0), igst: t };
  if (type === "UNREGISTERED") return { cgst: D(0), sgst: D(0), igst: D(0) };
  const cgst = money(t.div(2));
  return { cgst, sgst: t.minus(cgst), igst: D(0) };
}

/**
 * Document number: series (≤ 4) / financial year (YYyy, + "C" for a credit
 * note) / 5-digit sequence — at most 16 characters (GST rule 46). Credit notes
 * are marked in the year segment, so they can never collide with an invoice
 * number whatever the series is ("HYDC/2627/00001" vs "HYDC/2627C/00001").
 */
export function formatInvoiceNumber(series: string, fiscalYear: string, seq: number, kind: "INVOICE" | "CREDIT_NOTE" = "INVOICE"): string {
  const fy = fiscalYear.replace(/^\d\d(\d\d)-(\d\d)$/, "$1$2") + (kind === "CREDIT_NOTE" ? "C" : ""); // 2026-27 -> 2627 / 2627C
  const n = `${series.slice(0, 4)}/${fy}/${String(seq).padStart(5, "0")}`;
  if (n.length > 16) throw new Error(`Invoice number ${n} exceeds 16 characters`);
  return n;
}

/** A series prefix derived from an outlet code: up to 4 upper-case letters/digits. */
export function defaultSeries(outletCode: string): string {
  return (outletCode.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4) || "INV");
}

/** Zod schema for a GSTIN input: trimmed, upper-cased, format + state + checksum validated. */
export const gstinSchema = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .superRefine((v, c) => {
    const r = validateGstin(v);
    if (!r.valid) c.addIssue({ code: z.ZodIssueCode.custom, message: r.reason });
  });
