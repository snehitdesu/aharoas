/**
 * Accounting export abstraction (Tally / Zoho Books / generic). Produces
 * portable rows the exports service turns into CSV. Real API sync would be a
 * separate adapter; today we export files.
 */
export type AccountingEntry = {
  date: string;
  voucherType: string; // SALES | PURCHASE | PAYMENT | EXPENSE
  reference: string;
  party?: string;
  debit: number;
  credit: number;
  ledger: string;
  narration?: string;
};

export interface AccountingProvider {
  readonly name: string;
  /** Map normalized entries to the provider's column shape (headers + rows). */
  format(entries: AccountingEntry[]): { headers: string[]; rows: (string | number)[][] };
}

export class GenericAccountingProvider implements AccountingProvider {
  readonly name: string = "generic";
  format(entries: AccountingEntry[]) {
    const headers = ["Date", "Voucher Type", "Reference", "Party", "Ledger", "Debit", "Credit", "Narration"];
    const rows = entries.map((e) => [e.date, e.voucherType, e.reference, e.party ?? "", e.ledger, e.debit, e.credit, e.narration ?? ""]);
    return { headers, rows };
  }
}

export class TallyAccountingProvider extends GenericAccountingProvider {
  readonly name = "tally";
  // Tally-specific column ordering could differ; kept identical for the generic CSV path.
}

export function getAccountingProvider(name?: string): AccountingProvider {
  return (name ?? "generic").toLowerCase() === "tally" ? new TallyAccountingProvider() : new GenericAccountingProvider();
}
