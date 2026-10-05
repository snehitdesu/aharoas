/**
 * Accounting export formats. RESTORA stays the source of truth: the accounting
 * service (server/services/accounting.ts) turns finance records into balanced
 * double-entry vouchers; an AccountingFormat only serializes them —
 * deterministically (same vouchers → byte-identical file), so an export can be
 * re-downloaded and diffed.
 *
 *  - generic: one CSV row per ledger line (Date, Voucher type, Number, Ledger,
 *    Debit, Credit, Party, Narration, Source key).
 *  - tally:   Tally ERP / TallyPrime XML import envelope (vouchers with
 *    ALLLEDGERENTRIES.LIST; debits negative with ISDEEMEDPOSITIVE=Yes).
 *
 * There is NO live API sync to Tally / Zoho / QuickBooks: no partner
 * credentials are available, so only file export exists.
 */
export type VoucherType =
  | "SALES" | "CREDIT_NOTE" | "RECEIPT" | "REFUND" | "EXPENSE" | "EXPENSE_VOID"
  | "PURCHASE" | "PURCHASE_CANCEL" | "VENDOR_PAYMENT" | "VENDOR_PAYMENT_REVERSAL";

export type VoucherLine = { ledger: string; debit: number; credit: number };
export type Voucher = {
  /** Stable identity of the source document (e.g. "inv:<id>") — the duplicate guard. */
  sourceKey: string;
  date: string; // YYYY-MM-DD (outlet business day)
  type: VoucherType;
  number: string;
  party?: string;
  narration: string;
  lines: VoucherLine[];
};

export interface AccountingFormat {
  readonly name: "generic" | "tally";
  readonly mime: string;
  readonly extension: string;
  render(vouchers: Voucher[]): string;
}

const TALLY_TYPE: Record<VoucherType, string> = {
  SALES: "Sales", CREDIT_NOTE: "Credit Note", RECEIPT: "Receipt", REFUND: "Payment", EXPENSE: "Payment", EXPENSE_VOID: "Journal",
  PURCHASE: "Purchase", PURCHASE_CANCEL: "Debit Note", VENDOR_PAYMENT: "Payment", VENDOR_PAYMENT_REVERSAL: "Journal",
};

/** Sort so the same set of vouchers always renders identically. */
export const ordered = (vs: Voucher[]) => [...vs].sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type) || a.number.localeCompare(b.number) || a.sourceKey.localeCompare(b.sourceKey));

const csvCell = (v: string | number) => {
  const s = String(v);
  // Formula-injection guard (spreadsheets execute =, +, -, @ at the start of a cell).
  const safe = /^[=+\-@\t\r]/.test(s) && typeof v === "string" ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const amt = (n: number) => n.toFixed(2);

export class GenericAccountingFormat implements AccountingFormat {
  readonly name = "generic" as const;
  readonly mime = "text/csv";
  readonly extension = "csv";
  render(vouchers: Voucher[]): string {
    const rows = [["Date", "Voucher Type", "Voucher No", "Ledger", "Debit", "Credit", "Party", "Narration", "Source"]];
    for (const v of ordered(vouchers)) for (const l of v.lines) rows.push([v.date, v.type, v.number, l.ledger, l.debit ? amt(l.debit) : "", l.credit ? amt(l.credit) : "", v.party ?? "", v.narration, v.sourceKey]);
    return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }
}

const xml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

export class TallyAccountingFormat implements AccountingFormat {
  readonly name = "tally" as const;
  readonly mime = "application/xml";
  readonly extension = "xml";
  render(vouchers: Voucher[]): string {
    const body = ordered(vouchers).map((v) => {
      const entries = v.lines.map((l) => {
        const debit = l.debit > 0;
        return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xml(l.ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${debit ? "Yes" : "No"}</ISDEEMEDPOSITIVE><AMOUNT>${debit ? `-${amt(l.debit)}` : amt(l.credit)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
      }).join("");
      return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${TALLY_TYPE[v.type]}" ACTION="Create"><DATE>${v.date.replace(/-/g, "")}</DATE><VOUCHERTYPENAME>${TALLY_TYPE[v.type]}</VOUCHERTYPENAME><VOUCHERNUMBER>${xml(v.number)}</VOUCHERNUMBER>${v.party ? `<PARTYLEDGERNAME>${xml(v.party)}</PARTYLEDGERNAME>` : ""}<NARRATION>${xml(`${v.narration} [${v.sourceKey}]`)}</NARRATION>${entries}</VOUCHER></TALLYMESSAGE>`;
    }).join("");
    return `<?xml version="1.0" encoding="UTF-8"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC><REQUESTDATA>${body}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>\n`;
  }
}

export function getAccountingFormat(name?: string): AccountingFormat {
  return (name ?? "generic").toLowerCase() === "tally" ? new TallyAccountingFormat() : new GenericAccountingFormat();
}

/** A voucher is balanced when Σ debit = Σ credit (to the paisa). */
export const isBalanced = (v: Voucher) => Math.round(v.lines.reduce((a, l) => a + l.debit - l.credit, 0) * 100) === 0;
