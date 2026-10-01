/** Minimal, safe CSV serialization (RFC 4180). No external deps. */
export type CsvColumn<T> = { header: string; value: (row: T) => unknown };

const NUMERIC = /^-?\d+(\.\d+)?$/;

function escapeCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === "number" || typeof v === "bigint") return String(v); // numbers are never formulas
  else if (typeof v === "boolean") s = v ? "true" : "false";
  else if (typeof v === "object" && typeof (v as { toFixed?: unknown }).toFixed === "function") s = String(v); // Prisma.Decimal
  else s = typeof v === "object" ? JSON.stringify(v) : String(v);
  // Guard against CSV/formula injection in spreadsheet apps (plain numbers are left alone).
  if (/^[=+\-@\t\r]/.test(s) && !NUMERIC.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Header row + one CRLF-terminated line per row; column order is exactly `columns`. */
export function toCSV<T>(rows: T[], columns: CsvColumn<T>[], opts: { bom?: boolean } = {}): string {
  const lines = [columns.map((c) => escapeCell(c.header)).join(",")];
  for (const r of rows) lines.push(columns.map((c) => escapeCell(c.value(r))).join(","));
  return (opts.bom ? "﻿" : "") + lines.join("\r\n") + "\r\n";
}
