import { Prisma } from "@prisma/client";
import { z } from "zod";

export type Decimalish = Prisma.Decimal | number | string;

export const D = (v: Decimalish = 0): Prisma.Decimal => new Prisma.Decimal(v);

export const dAdd = (a: Decimalish, b: Decimalish) => D(a).plus(D(b));
export const dSub = (a: Decimalish, b: Decimalish) => D(a).minus(D(b));
export const dMul = (a: Decimalish, b: Decimalish) => D(a).times(D(b));
export const dDiv = (a: Decimalish, b: Decimalish) => {
  const denom = D(b);
  if (denom.isZero()) return D(0);
  return D(a).div(denom);
};

/** Round to 2 dp for currency. */
export const money = (v: Decimalish) => D(v).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
/** Round to 4 dp for quantities. */
export const qty = (v: Decimalish) => D(v).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);

export const num = (v: Decimalish) => D(v).toNumber();

/**
 * A money amount received from a client (JSON number): finite, at most 2
 * decimal places (no sub-paisa amounts that would be silently rounded), and
 * within the PostgreSQL MONEY class (scripts/pg-schema.mjs). Pass the sign
 * rule in: moneyAmount(z.number().positive()).
 */
export const moneyAmount = (base: z.ZodNumber = z.number()) =>
  base
    .finite()
    .refine((v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6, "Amounts can have at most 2 decimal places")
    .refine((v) => Math.abs(v) <= 100_000_000_000, "Amount is too large");
