/**
 * Google Sheets sync abstraction (two-way). Business logic is decoupled from
 * Google; a mock in-memory provider runs locally. Real sync requires Google
 * service-account credentials from env — never hardcoded.
 */
export type SheetRow = Record<string, string | number | null>;

export interface SheetsProvider {
  readonly name: string;
  push(sheet: string, rows: SheetRow[]): Promise<{ pushed: number }>;
  pull(sheet: string): Promise<SheetRow[]>;
  healthCheck(): Promise<boolean>;
}

/** In-memory mock; data survives only for the process (dev/testing). */
export class MockSheetsProvider implements SheetsProvider {
  readonly name = "mock";
  private store = new Map<string, SheetRow[]>();
  async push(sheet: string, rows: SheetRow[]) {
    this.store.set(sheet, [...(this.store.get(sheet) ?? []), ...rows]);
    return { pushed: rows.length };
  }
  async pull(sheet: string) {
    return this.store.get(sheet) ?? [];
  }
  async healthCheck() {
    return true;
  }
}

export class GoogleSheetsProvider implements SheetsProvider {
  readonly name = "google";
  private configured() {
    return Boolean(process.env.GOOGLE_SHEETS_CLIENT_EMAIL && process.env.GOOGLE_SHEETS_PRIVATE_KEY);
  }
  async push(): Promise<{ pushed: number }> {
    if (!this.configured()) throw new Error("Google Sheets not configured (set GOOGLE_SHEETS_* env)");
    throw new Error("GoogleSheetsProvider not implemented; use GOOGLE_SHEETS_PROVIDER=mock in development.");
  }
  async pull(): Promise<SheetRow[]> {
    if (!this.configured()) throw new Error("Google Sheets not configured");
    throw new Error("GoogleSheetsProvider not implemented");
  }
  async healthCheck() {
    return this.configured();
  }
}

export function getSheetsProvider(): SheetsProvider {
  return (process.env.GOOGLE_SHEETS_PROVIDER ?? "mock").toLowerCase() === "google" ? new GoogleSheetsProvider() : new MockSheetsProvider();
}
