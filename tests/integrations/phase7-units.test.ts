/**
 * Phase 7 pure units: ESC/POS rendering, the printer-address SSRF guard, phone
 * normalization / masking, accounting file formats (deterministic, balanced,
 * spreadsheet-formula safe, XML-escaped) and bounded backoff.
 */
import { describe, it, expect, afterEach } from "vitest";
import { ascii, bytes, ESC, kotDoc, plain, testDoc } from "@/integrations/printer/escpos";
import { printerAddressProblem, sendToPrinter } from "@/integrations/printer";
import { maskPhone, normalizePhone, MockMessagingProvider, TwilioMessagingProvider } from "@/integrations/messaging";
import { GenericAccountingFormat, TallyAccountingFormat, isBalanced, type Voucher } from "@/integrations/accounting";
import { nextAttemptAt } from "@/integrations/http";

afterEach(() => {
  delete process.env.PRINTER_ALLOW_LOOPBACK;
  delete process.env.PRINTER_EXTRA_PORTS;
});

describe("ESC/POS", () => {
  it("renders printable ASCII, init + cut, optional drawer kick", () => {
    expect(ascii("₹ 100 — naïve")).toBe("Rs. 100  naive");
    const b = bytes([{ text: "Hello", bold: true }], { kickDrawer: true });
    expect([...b.subarray(0, 2)]).toEqual([...ESC.init]);
    expect(b.includes(Buffer.from(ESC.drawerKick))).toBe(true);
    expect(b.subarray(-4).equals(Buffer.from(ESC.cut))).toBe(true);
    expect(bytes([{ text: "x" }], { cut: false }).includes(Buffer.from(ESC.cut))).toBe(false);
  });
  it("KOT shows station, table, quantities, modifiers and notes; reprints are marked", () => {
    const doc = kotDoc({ number: 12, station: "BAR", table: "T4", channel: "DINE_IN", orderRef: "ABC123", createdAt: "05/10/26, 7:30 pm", items: [{ name: "Cold coffee", qty: "2", modifiers: ["Extra shot"], notes: "no ice" }] }, 32, { reprint: true });
    const t = plain(doc);
    for (const s of ["KOT 12", "BAR", "Table T4", "#ABC123", "2 x Cold coffee", "+ Extra shot", "NOTE: no ice", "REPRINT"]) expect(t).toContain(s);
    expect(plain(testDoc("Front", 32, "now"))).toContain("printing works");
  });
});

describe("printer address guard (SSRF)", () => {
  it("accepts private LAN IPv4 on raw-print ports only", () => {
    expect(printerAddressProblem("192.168.1.50", 9100)).toBeNull();
    expect(printerAddressProblem("10.1.2.3", 9105)).toBeNull();
    expect(printerAddressProblem("172.20.0.9", 9100)).toBeNull();
    expect(printerAddressProblem("172.32.0.9", 9100)).toMatch(/private LAN/);
    expect(printerAddressProblem("169.254.169.254", 9100)).toMatch(/private LAN/);
    expect(printerAddressProblem("8.8.8.8", 9100)).toMatch(/private LAN/);
    expect(printerAddressProblem("printer.local", 9100)).toMatch(/IPv4/);
    expect(printerAddressProblem("192.168.1.50", 22)).toMatch(/port/);
    expect(printerAddressProblem("127.0.0.1", 9100)).toMatch(/Loopback/);
    process.env.PRINTER_ALLOW_LOOPBACK = "true";
    expect(printerAddressProblem("127.0.0.1", 9100)).toBeNull();
    expect(printerAddressProblem(null, 9100)).toMatch(/IP address/);
  });
  it("never connects to a refused address; unknown transports fail", async () => {
    expect(await sendToPrinter({ transport: "NETWORK_ESCPOS", host: "169.254.169.254", port: 9100 }, Buffer.from("x"))).toMatchObject({ ok: false, retryable: false });
    expect(await sendToPrinter({ transport: "USB_MAGIC" }, Buffer.from("x"))).toMatchObject({ ok: false });
    expect(await sendToPrinter({ transport: "SIMULATED" }, Buffer.from("x"))).toEqual({ ok: true, simulated: true });
  });
});

describe("messaging helpers", () => {
  it("normalizes Indian numbers to E.164 and masks them", () => {
    expect(normalizePhone("98765 43210")).toBe("+919876543210");
    expect(normalizePhone("919876543210")).toBe("+919876543210");
    expect(normalizePhone("+14155550123")).toBe("+14155550123");
    expect(normalizePhone("12345")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(maskPhone("+919876543210")).toBe("+91******3210");
  });
  it("the MOCK provider is labelled MOCK and never accepts callbacks", async () => {
    const m = new MockMessagingProvider();
    expect(m.mode).toBe("MOCK");
    expect((await m.send({ channel: "SMS", to: "+919876543210", body: "hi" })).providerRef).toMatch(/^mockmsg_/);
    expect(m.verifyStatusCallback()).toBe(false);
  });
  it("Twilio maps statuses forward and refuses unsigned callbacks", () => {
    const t = new TwilioMessagingProvider({ accountSid: `AC${"c".repeat(32)}`, authToken: "token-token-token-1" }, "SANDBOX", async () => new Response("{}"));
    expect(t.parseStatusCallback({ MessageSid: "SM1", MessageStatus: "delivered" })).toEqual({ providerRef: "SM1", status: "DELIVERED" });
    expect(t.parseStatusCallback({ MessageSid: "SM1", MessageStatus: "undelivered", ErrorCode: "30003" })).toMatchObject({ status: "FAILED", error: "Twilio error 30003" });
    expect(t.parseStatusCallback({ MessageSid: "SM1", MessageStatus: "queued" })).toBeNull();
    expect(t.verifyStatusCallback("https://x", { a: "1" }, undefined)).toBe(false);
  });
});

describe("accounting formats", () => {
  const v = (over: Partial<Voucher> = {}): Voucher => ({ sourceKey: "inv:1", date: "2026-10-05", type: "SALES", number: "INV/1", narration: "Sales", lines: [{ ledger: "Sales Receivable", debit: 105, credit: 0 }, { ledger: "Sales", debit: 0, credit: 100 }, { ledger: "Output CGST", debit: 0, credit: 2.5 }, { ledger: "Output SGST", debit: 0, credit: 2.5 }], ...over });
  it("balanced check, deterministic CSV regardless of input order, formula-safe cells", () => {
    expect(isBalanced(v())).toBe(true);
    expect(isBalanced(v({ lines: [{ ledger: "a", debit: 1, credit: 0 }] }))).toBe(false);
    const g = new GenericAccountingFormat();
    const a = v();
    const b = v({ sourceKey: "exp:1", type: "EXPENSE", number: "EXP/1", narration: "=HYPERLINK(\"http://evil\")", lines: [{ ledger: "Expense - GAS", debit: 50, credit: 0 }, { ledger: "Cash", debit: 0, credit: 50 }] });
    expect(g.render([a, b])).toBe(g.render([b, a]));
    expect(g.render([b])).toContain(`"'=HYPERLINK(""http://evil"")"`);
  });
  it("Tally XML: escaped, debit negative / deemed positive", () => {
    const x = new TallyAccountingFormat().render([v({ party: "A & B <Co>" })]);
    expect(x).toContain("<PARTYLEDGERNAME>A &amp; B &lt;Co&gt;</PARTYLEDGERNAME>");
    expect(x).toContain("<LEDGERNAME>Sales Receivable</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-105.00</AMOUNT>");
    expect(x).toContain("<LEDGERNAME>Sales</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>100.00</AMOUNT>");
    expect(x).toContain("<DATE>20261005</DATE>");
  });
});

describe("retry backoff", () => {
  it("is bounded: 1, 5, 30, 120 minutes, then stays at 120", () => {
    const t0 = new Date("2026-10-05T00:00:00Z");
    expect([1, 2, 3, 4, 9].map((n) => (nextAttemptAt(n, t0).getTime() - t0.getTime()) / 60000)).toEqual([1, 5, 30, 120, 120]);
  });
});
