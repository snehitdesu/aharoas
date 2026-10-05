import type { Metadata } from "next";
import Link from "next/link";
import { ProsePage } from "@/site/components/Prose";
import { release } from "@/site/release";

export const metadata: Metadata = {
  title: "Release notes",
  description: `RESTORA ${release.version} release notes: what is included, what changed, upgrade notes and known limitations.`,
  alternates: { canonical: "/resources/release-notes" },
};

/** Public summary of docs/release-notes.md. */
export default function ReleaseNotesPage() {
  return (
    <ProsePage eyebrow="Release notes" title={`RESTORA ${release.version}`} intro="Release candidate, 5 October 2026. The first complete version of the restaurant operating system.">
      <h2>What RESTORA 1.0 is</h2>
      <p>A restaurant operating system for one restaurant business with one or more outlets, as a web application on PostgreSQL and a Windows desktop application with an embedded database on a single computer.</p>
      <table>
        <thead>
          <tr>
            <th scope="col">Area</th>
            <th scope="col">Included</th>
          </tr>
        </thead>
        <tbody>
          {[
            ["POS", "Dine-in, takeaway and delivery orders; menu with variants and modifiers; rounds; discounts; split and partial payments; refunds; bills and receipts; safe retries."],
            ["QR ordering", "Guest menu and ordering from a table QR code, optional online prepayment, order tracking, staff acceptance."],
            ["Kitchen", "KOTs per station; kitchen display (accept, preparing, ready, served); voids; automatic KOT printing."],
            ["Captain and manager apps", "Phone-first table board, rounds and bill requests; the manager's live day, alerts and staff."],
            ["Inventory", "Materials, units and conversions; versioned recipes with approval and costing; recipe-based consumption; opening stock, adjustments, transfers, issues, stock counts, wastage and production; append-only ledger at weighted average cost."],
            ["Procurement", "Indents, purchase orders, goods receipts, vendor bills, vendor payments, dues and aging."],
            ["Finance", "GST-ready invoices and credit notes, gap-free per financial year; expenses; petty cash; cash drawer with expected cash and variance; daily reconciliation and closing; profit and loss."],
            ["Analytics and reports", "Sales, menu, inventory and finance analytics; reports with CSV and background exports."],
            ["Integrations", "Razorpay (contract-tested), network ESC/POS printers and cash drawer, Twilio SMS and WhatsApp (contract-tested), CSV and Tally XML accounting export, aggregator webhooks (mock adapters)."],
            ["Security", "Roles per outlet and organisation, step-up re-authentication, session security, security headers, audit log, encrypted integration secrets."],
          ].map(([a, b]) => (
            <tr key={a}>
              <td>
                <strong>{a}</strong>
              </td>
              <td>{b}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>New in this release</h2>
      <ul>
        <li>The new RESTORA identity and design system, with a new icon and installer name.</li>
        <li>Order placement holds up under concurrent load: in testing, 200 of 200 simultaneous kitchen orders succeeded.</li>
        <li>New database indexes make bills and rounds faster on large databases.</li>
        <li>A database outage now returns a clear &quot;unavailable&quot; answer and the app reconnects by itself.</li>
        <li>A table is released only when its last open order closes, so several QR orders per table no longer free it early.</li>
      </ul>

      <h2>Upgrading</h2>
      <ul>
        <li>Web: one additive database migration (indexes only). Run it in a quiet window on large databases.</li>
        <li>Desktop: installs as RESTORA and upgrades earlier installations in place, keeping their data. You may need to sign in once more.</li>
      </ul>

      <h2>Known limitations</h2>
      <ul>
        <li>One app instance per web deployment.</li>
        <li>No multi-factor authentication.</li>
        <li>The Windows installer is not code-signed in this candidate.</li>
        <li>Password-reset links are handed over by a manager; there is no email or SMS delivery yet.</li>
        <li>The Razorpay and Twilio adapters have not yet run against live accounts.</li>
        <li>The macOS app is configured but not yet verified on a Mac.</li>
      </ul>

      <h2>Compliance limitations</h2>
      <p>RESTORA produces GST-ready records. It is not a certified GST invoicing system: no e-invoicing (IRN or signed QR), no digital signature, no debit notes or invoice cancellation, and no GSTR filing. There is no consent capture or erasure workflow for guest data yet. Professional review is required.</p>

      <h2>Not in 1.0</h2>
      <ul>
        <li>Several separate restaurant businesses in one account.</li>
        <li>Live Swiggy and Zomato connections, Petpooja import, and live accounting sync with Tally, Zoho or QuickBooks.</li>
        <li>E-invoicing and GST returns.</li>
        <li>Dark mode.</li>
      </ul>

      <p>
        <Link href="/download">Download RESTORA {release.version}</Link>
      </p>
    </ProsePage>
  );
}
