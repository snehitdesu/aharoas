/**
 * Printer transports. Business code never talks to a device: the printing
 * service renders ESC/POS bytes and hands them to a transport.
 *
 *  - NETWORK_ESCPOS: raw ESC/POS over TCP ("port 9100" / JetDirect), the
 *    protocol of networked thermal receipt / kitchen printers and their cash
 *    drawer kick-out. Implemented and tested against a TCP endpoint; whether a
 *    given printer model renders it correctly is NOT verified here.
 *  - SIMULATED: no hardware. Accepts the job, reports `simulated: true`; the
 *    service records it as SIMULATED, never as printed.
 *
 * SSRF guard: the destination must be an IPv4 literal in a private LAN range
 * (10/8, 172.16/12, 192.168/16) on an allowed port (9100–9109 by default). No
 * hostnames (no DNS rebinding), no public, link-local (169.254 — cloud
 * metadata) or loopback addresses unless the deployment explicitly allows
 * loopback (tests / a printer proxy on the same machine).
 */
import net from "node:net";

export type PrinterTransportKind = "NETWORK_ESCPOS" | "SIMULATED";
export type PrinterTarget = { transport: PrinterTransportKind | string; host?: string | null; port?: number | null };
export type SendResult = { ok: true; simulated: boolean } | { ok: false; error: string; retryable: boolean };

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function allowedPorts(): Set<number> {
  const extra = (process.env.PRINTER_EXTRA_PORTS ?? "").split(",").map((p) => Number(p.trim())).filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  return new Set([9100, 9101, 9102, 9103, 9104, 9105, 9106, 9107, 9108, 9109, ...extra]);
}

/** Why a printer address is refused, or null when it is acceptable. */
export function printerAddressProblem(host: string | null | undefined, port: number | null | undefined): string | null {
  if (!host) return "A network printer needs an IP address";
  if (!IPV4.test(host)) return "Use the printer's IPv4 address (host names are not accepted)";
  const [a, b] = host.split(".").map(Number);
  const loopback = a === 127;
  const privateLan = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  if (loopback && process.env.PRINTER_ALLOW_LOOPBACK !== "true") return "Loopback addresses are not allowed for printers";
  if (!privateLan && !loopback) return "Only private LAN addresses (10.x, 172.16–31.x, 192.168.x) are allowed for printers";
  if (!port || !allowedPorts().has(port)) return "Printer port must be a raw-print port (9100–9109)";
  return null;
}

/** Send bytes to the printer. Never throws; a refused address is a non-retryable failure. */
export async function sendToPrinter(target: PrinterTarget, data: Buffer, timeoutMs = 4000): Promise<SendResult> {
  if (target.transport === "SIMULATED") return { ok: true, simulated: true };
  if (target.transport !== "NETWORK_ESCPOS") return { ok: false, error: "Unsupported printer transport", retryable: false };
  const problem = printerAddressProblem(target.host, target.port);
  if (problem) return { ok: false, error: problem, retryable: false };
  return new Promise<SendResult>((resolve) => {
    const socket = net.createConnection({ host: target.host!, port: target.port! });
    let settled = false;
    const done = (r: SendResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, error: "Printer did not respond (timeout)", retryable: true }), timeoutMs);
    socket.once("error", (e: NodeJS.ErrnoException) => done({ ok: false, error: e.code === "ECONNREFUSED" ? "Printer refused the connection (offline?)" : e.code === "EHOSTUNREACH" ? "Printer unreachable" : "Printer connection failed", retryable: true }));
    socket.once("connect", () => {
      socket.end(data, () => done({ ok: true, simulated: false }));
    });
  });
}

/** Is the printer reachable (TCP connect, nothing printed)? */
export async function probePrinter(target: PrinterTarget, timeoutMs = 2500): Promise<{ online: boolean; simulated: boolean; error?: string }> {
  if (target.transport === "SIMULATED") return { online: true, simulated: true };
  if (target.transport !== "NETWORK_ESCPOS") return { online: false, simulated: false, error: "Unsupported printer transport" };
  const problem = printerAddressProblem(target.host, target.port);
  if (problem) return { online: false, simulated: false, error: problem };
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: target.host!, port: target.port! });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ online: false, simulated: false, error: "Printer did not respond (timeout)" });
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ online: true, simulated: false });
    });
    socket.once("error", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ online: false, simulated: false, error: "Printer unreachable" });
    });
  });
}
