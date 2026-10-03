/**
 * Hardware abstraction (main process only). The renderer reaches it through a
 * few validated IPC calls; it never gets device or filesystem access.
 *
 * Printers (receipt / KOT / kitchen) implement PrinterDriver:
 *  - "system": renders the job's HTML in a hidden, script-less window and prints
 *    it silently to a named Windows printer (any installed thermal printer driver).
 *  - "mock":   development/no-hardware driver. Writes the job to print-spool\ and
 *    reports `simulated: true` — it never claims that paper came out.
 * ESC/POS raw printing (cash-drawer kick, cutter) is the planned "escpos" driver.
 */
import { BrowserWindow, type WebContents } from "electron";
import fs from "node:fs";
import path from "node:path";

export type PrintJob = { kind: "receipt" | "kot" | "test"; title: string; html: string };
export type PrintResult =
  | { ok: true; driver: "mock" | "system"; simulated: boolean; deviceName?: string; spoolFile?: string }
  | { ok: false; driver: "mock" | "system"; error: string };

export interface PrinterDriver {
  readonly name: "mock" | "system";
  print(job: PrintJob): Promise<PrintResult>;
}

export class MockPrinterDriver implements PrinterDriver {
  readonly name = "mock" as const;
  constructor(private readonly spoolDir: string) {}
  async print(job: PrintJob): Promise<PrintResult> {
    fs.mkdirSync(this.spoolDir, { recursive: true });
    const file = path.join(this.spoolDir, `${Date.now()}-${job.kind}.html`);
    fs.writeFileSync(file, job.html, "utf8");
    return { ok: true, driver: "mock", simulated: true, spoolFile: path.basename(file) };
  }
}

export class SystemPrinterDriver implements PrinterDriver {
  readonly name = "system" as const;
  constructor(private readonly deviceName: string) {}
  async print(job: PrintJob): Promise<PrintResult> {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, partition: "aharos-print" },
    });
    try {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(job.html)}`);
      return await new Promise<PrintResult>((resolve) => {
        win.webContents.print({ silent: true, deviceName: this.deviceName, printBackground: false }, (success, failureReason) => {
          resolve(success ? { ok: true, driver: "system", simulated: false, deviceName: this.deviceName } : { ok: false, driver: "system", error: failureReason || "Print failed" });
        });
      });
    } finally {
      win.destroy();
    }
  }
}

export type PrinterInfo = { name: string; displayName: string; isDefault: boolean };

export async function listPrinters(wc: WebContents): Promise<PrinterInfo[]> {
  const printers = await wc.getPrintersAsync();
  return printers.map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: Boolean((p as { isDefault?: boolean }).isDefault) }));
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function testPage(version: string, now = new Date()): PrintJob {
  return {
    kind: "test",
    title: "Aharos test print",
    html: `<!doctype html><meta charset="utf-8"><body style="font:12px monospace;width:72mm"><h3>Aharos</h3><p>Printer test</p><p>${escapeHtml(now.toLocaleString())}</p><p>v${escapeHtml(version)}</p></body>`,
  };
}
